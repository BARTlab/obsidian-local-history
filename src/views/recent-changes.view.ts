import { PluginEvent, RECENT_CHANGES_VIEW_TYPE } from '@/consts';
import { DomHelper } from '@/helpers/dom.helper';
import { VersionLabelHelper } from '@/helpers/version-label.helper';
import type LineChangeTrackerPlugin from '@/main';
import type { ModalsService } from '@/services/modals.service';
import type { SnapshotsService } from '@/services/snapshots.service';
import type { VersionActionsService } from '@/services/version-actions.service';
import type { FileSnapshot } from '@/snapshots/file.snapshot';
import type { FileVersion } from '@/snapshots/file.version';
import type { DomElementConfig, VersionDescription } from '@/types';
import { type IconName, ItemView, Menu, type MenuItem, type TFile, type WorkspaceLeaf, setIcon } from 'obsidian';

/**
 * Right-sidebar navigator for the active file's version timeline (D3).
 *
 * T11 fills the lifecycle skeleton from T10 with the timeline rows: each row
 * shows the action label (or the user's custom label), the capture date, and
 * the line delta inline, newest first. The panel reacts to active-leaf-change
 * so switching files re-renders against the new file's timeline, and a
 * snapshot update (capture, restore, remove, put-label) is mirrored so the
 * panel never lags behind the rail. Double-clicking a row opens the history
 * modal in rail-less mode focused on that version (D4), so the panel stays
 * the sole navigator in that session.
 *
 * @extends {ItemView}
 */
export class RecentChangesView extends ItemView {
  /**
   * Container that holds the timeline rows for the active file. Built once on
   * onOpen and re-filled on every render so the wrapper class survives between
   * re-renders for stable CSS targeting.
   */
  protected listEl?: HTMLElement;

  /**
   * Creates a new instance of RecentChangesView.
   *
   * @param {WorkspaceLeaf} leaf - The workspace leaf hosting this view
   * @param {LineChangeTrackerPlugin} plugin - The plugin instance, retained so
   *   the view can reach services through the DI container
   */
  public constructor(
    leaf: WorkspaceLeaf,
    protected plugin: LineChangeTrackerPlugin,
  ) {
    super(leaf);
  }

  /**
   * Returns the stable view type id used to register and look up the view.
   *
   * @return {string} The view type id
   * @override
   */
  public getViewType(): string {
    return RECENT_CHANGES_VIEW_TYPE;
  }

  /**
   * Returns the user-facing title rendered in the sidebar tab.
   *
   * @return {string} The localized display text
   * @override
   */
  public getDisplayText(): string {
    return this.plugin.t('view.recent-changes.title');
  }

  /**
   * Returns the Lucide icon id rendered in the sidebar tab. Matches the
   * `history` icon used by the modal's toolbar so the surface is recognisable.
   *
   * @return {IconName} The Lucide icon id
   * @override
   */
  public getIcon(): IconName {
    return 'history';
  }

  /**
   * Resolves the view type id this view exposes. Convenience for the reveal
   * entry point (and tests) so callers do not have to import the constant.
   *
   * @return {string} The view type id
   */
  public static get viewType(): string {
    return RECENT_CHANGES_VIEW_TYPE;
  }

  /**
   * Lifecycle hook called when Obsidian opens the view.
   *
   * Prepares the content host, mounts the timeline list container, subscribes
   * to active-leaf-change and the internal snapshots-update event, and renders
   * the initial state against the active file. Subscriptions go through
   * `registerEvent` and the Component `register` cleanup so a detach of the
   * leaf tears them down with no leaks (T10's AC3 contract).
   *
   * @return {Promise<void>} Resolves once the host is prepared
   * @override
   */
  protected async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass('lct-recent-changes-view');

    this.listEl = DomHelper.create({
      tag: 'div',
      classes: 'lct-recent-changes-list',
      container: this.contentEl,
    });

    /**
     * Active-leaf-change is a native Obsidian event; routed through
     * registerEvent so the ref releases with the view.
     */
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', (): void => {
        this.render();
      }),
    );

    /**
     * Internal snapshot updates (capture, restore, remove, put-label) flow
     * through the plugin emitter, not the workspace, so subscribe directly and
     * detach on close via the Component `register` hook.
     */
    const onSnapshotUpdate = (): void => this.render();

    this.plugin.on(PluginEvent.snapshotsUpdate, onSnapshotUpdate, this);
    this.register((): void => {
      this.plugin.off(PluginEvent.snapshotsUpdate, onSnapshotUpdate, this);
    });

    this.render();
  }

  /**
   * Lifecycle hook called when Obsidian closes the view.
   *
   * Empties the content host so a re-open starts from a clean DOM. Component
   * lifetime handles any registered event refs and dom listeners, so no
   * explicit detach is needed here.
   *
   * @return {Promise<void>} Resolves once the host is cleared
   * @override
   */
  protected async onClose(): Promise<void> {
    this.contentEl.empty();
    this.listEl = undefined;
  }

  /**
   * Renders the timeline rows for the active file into the list container.
   *
   * With no active file or no snapshot the panel shows a single muted hint,
   * keeping the AC for "react to the active file" intact (an empty render IS
   * the reaction). With a snapshot the rows mirror the modal rail format
   * (action or custom label, capture date inline, line delta inline) but
   * without the rail's grouping and search, since the panel is a thin
   * navigator (D3).
   */
  protected render(): void {
    if (!this.listEl) {
      return;
    }

    const file: TFile | null = this.plugin.getActiveFile();
    const snapshot: FileSnapshot | null = this.plugin
      .get<SnapshotsService>('SnapshotsService')
      .getOne(file);

    if (!file || !snapshot) {
      DomHelper.update(this.listEl, {
        text: null,
        children: [
          {
            tag: 'div',
            classes: 'lct-recent-changes-empty',
            text: this.plugin.t('view.recent-changes.empty'),
          },
        ],
      });

      return;
    }

    const versions: FileVersion[] = snapshot.getVersions();

    if (versions.length === 0) {
      DomHelper.update(this.listEl, {
        text: null,
        children: [
          {
            tag: 'div',
            classes: 'lct-recent-changes-empty',
            text: this.plugin.t('view.recent-changes.empty'),
          },
        ],
      });

      return;
    }

    DomHelper.update(this.listEl, {
      text: null,
      children: versions.map((version: FileVersion): DomElementConfig =>
        this.makeRow(version, versions, snapshot, file),
      ),
    });

    this.paintExternalBadges(this.listEl);
  }

  /**
   * Mirrors `HistoryModal.paintExternalBadges`: after the DomHelper config tree
   * is mounted, apply Obsidian's `setIcon` to every badge slot the row config
   * declared. The badge text and icon id (`data-icon` on the wrapper) match the
   * rail's badge so external versions read consistently across surfaces (AC2).
   *
   * @param {HTMLElement} container - The list container to scan
   */
  protected paintExternalBadges(container: HTMLElement): void {
    const badges: NodeListOf<HTMLElement> = container.querySelectorAll<HTMLElement>(
      '.lct-version-external-badge',
    );

    badges.forEach((badge: HTMLElement): void => {
      const iconId: string | null = badge.getAttribute('data-icon');
      const slot: HTMLElement | null = badge.querySelector<HTMLElement>('.lct-version-external-badge-icon');

      if (iconId && slot) {
        setIcon(slot, iconId);
      }
    });
  }

  /**
   * Builds the DomHelper config for a single timeline row. Mirrors the modal
   * rail's primary label (custom label or derived action), the inline capture
   * date+time, and the `+A -B` line delta. Double-click opens the history
   * modal in rail-less mode focused on this version (D4): the panel stays the
   * sole navigator, the modal acts as a pure viewer.
   *
   * @param {FileVersion} version - The version this row represents
   * @param {FileVersion[]} versions - The full timeline, newest first
   * @param {FileSnapshot} snapshot - The snapshot the timeline belongs to
   * @param {TFile} file - The file the snapshot belongs to (captured at render
   *   time so a later active-file switch cannot retarget the click)
   * @return {DomElementConfig} The DomHelper config for the row
   */
  protected makeRow(
    version: FileVersion,
    versions: FileVersion[],
    snapshot: FileSnapshot,
    file: TFile,
  ): DomElementConfig {
    const description: VersionDescription = this.describeVersion(version, versions, snapshot);
    const label: string = this.resolveLabel(version, description);
    const delta: string = this.formatDelta(description);

    const labelChildren: DomElementConfig[] = [
      { tag: 'span', classes: 'lct-recent-changes-label', text: label },
    ];

    if (version.isExternal()) {
      labelChildren.push(this.makeExternalBadge());
    }

    const children: DomElementConfig[] = [
      { tag: 'span', classes: 'lct-recent-changes-label-row', children: labelChildren },
      { tag: 'span', classes: 'lct-recent-changes-meta', text: version.getDateTime() },
    ];

    if (delta) {
      children.push({ tag: 'span', classes: 'lct-recent-changes-delta', text: delta });
    }

    return {
      tag: 'div',
      classes: 'lct-recent-changes-item',
      events: {
        dblclick: (): void => {
          this.openInModal(file, version.id);
        },
        contextmenu: (event: Event): void => {
          this.openRowMenu(event as MouseEvent, file, version);
        },
      },
      children,
    };
  }

  /**
   * Builds the inline external-change badge config (D13, T20). Mirrors the
   * rail's badge shape so the panel and the modal feel consistent: a Lucide
   * `download-cloud` icon paired with a short text label, wrapped in an
   * `aria-label`-tagged span so assistive tech announces the marker. The icon
   * id is carried as `data-icon` so {@link paintExternalBadges} can mount the
   * glyph after DomHelper builds the config tree. The text ships as an inline
   * English literal and is propagated to every catalog in T15.
   *
   * @return {DomElementConfig} The badge element config
   */
  protected makeExternalBadge(): DomElementConfig {
    const text: string = this.plugin.t('version.badge.external');

    return {
      tag: 'span',
      classes: 'lct-version-external-badge',
      attributes: { 'aria-label': text, 'title': text, 'data-icon': 'download-cloud' },
      children: [
        { tag: 'span', classes: 'lct-version-external-badge-icon' },
        { tag: 'span', classes: 'lct-version-external-badge-text', text },
      ],
    };
  }

  /**
   * Opens the per-row context menu (T12). Mirrors the modal toolbar wiring so
   * the panel and the modal share one behaviour for restore/delete/put-label
   * (D5): "Show diff" opens the rail-less viewer focused on this version, the
   * destructive actions confirm through the same prompts the modal uses, and
   * Put label routes through the prompt+VersionActionsService entry point on
   * ModalsService so an empty/cancel input is a silent no-op (T06). The native
   * browser menu is suppressed so only the plugin menu shows up.
   *
   * The captured `file` is the one resolved at row render time, so a later
   * active-file switch cannot retarget the action at the wrong timeline (same
   * guarantee the double-click handler relies on).
   *
   * @param {MouseEvent} event - The captured `contextmenu` event from the row
   * @param {TFile} file - The file the version belongs to
   * @param {FileVersion} version - The version this row represents
   */
  protected openRowMenu(event: MouseEvent, file: TFile, version: FileVersion): void {
    event.preventDefault();

    const menu: Menu = new Menu();
    const modalsService: ModalsService = this.plugin.get<ModalsService>('ModalsService');
    const versionActionsService: VersionActionsService =
      this.plugin.get<VersionActionsService>('VersionActionsService');

    menu.addItem((item: MenuItem): void => {
      item
        .setTitle(this.plugin.t('view.recent-changes.menu.show-diff'))
        .setIcon('file-diff')
        .onClick((): void => {
          this.openInModal(file, version.id);
        });
    });

    menu.addItem((item: MenuItem): void => {
      item
        .setTitle(this.plugin.t('view.recent-changes.menu.restore'))
        .setIcon('history')
        .onClick(async (): Promise<void> => {
          const confirmed: boolean = await modalsService.confirm({
            title: this.plugin.t('modal.confirm.restore-version.title'),
            message: this.plugin.t('modal.confirm.restore-version.message'),
            confirmText: this.plugin.t('modal.confirm.restore-version.button'),
            cancelText: this.plugin.t('modal.confirm.cancel'),
          });

          if (!confirmed) {
            return;
          }

          await versionActionsService.restoreSelected(file, version.id);
        });
    });

    menu.addItem((item: MenuItem): void => {
      item
        .setTitle(this.plugin.t('view.recent-changes.menu.delete'))
        .setIcon('list-x')
        .onClick(async (): Promise<void> => {
          const confirmed: boolean = await modalsService.confirm({
            title: this.plugin.t('modal.confirm.remove-version.title'),
            message: this.plugin.t('modal.confirm.remove-version.message'),
            confirmText: this.plugin.t('modal.confirm.remove-version.button'),
            cancelText: this.plugin.t('modal.confirm.cancel'),
          });

          if (!confirmed) {
            return;
          }

          versionActionsService.removeSelected(file, version.id);
        });
    });

    menu.addItem((item: MenuItem): void => {
      item
        .setTitle(this.plugin.t('view.recent-changes.menu.put-label'))
        .setIcon('tag')
        .onClick((): void => {
          /**
           * Label the version this row represents, NOT the file's current
           * content: a right-click on a past slice must tag that slice. Route
           * through ModalsService.labelVersion so the prompt strings and the
           * empty/cancel no-op stay aligned with the rest of the put-label UX.
           * The row's file is captured at render time so an active-file switch
           * between right-click and confirm cannot retarget the label.
           */
          void modalsService.labelVersion(file, version.id);
        });
    });

    menu.showAtMouseEvent(event);
  }

  /**
   * Returns the primary label shown on a row: the user's custom label when
   * present (D1), otherwise the derived action text translated from
   * VersionLabelHelper.describe against the version's previous neighbour. The
   * oldest version's previous neighbour is the history baseline.
   *
   * @param {FileVersion} version - The version to label
   * @param {VersionDescription} description - The cached describe result
   * @return {string} The primary label string
   */
  protected resolveLabel(version: FileVersion, description: VersionDescription): string {
    if (version.isLabeled()) {
      return version.label as string;
    }

    return this.plugin.t(`modal.version.action.${description.kind}`);
  }

  /**
   * Computes the derived action description for a version against its previous
   * neighbour. The neighbour is the next-older captured version, or the file's
   * history baseline when the version is the oldest one on the timeline.
   * Mirrors HistoryModal.describeVersion so the panel and the rail label the
   * same content identically.
   *
   * @param {FileVersion} version - The version to describe
   * @param {FileVersion[]} versions - The full timeline, newest first
   * @param {FileSnapshot} snapshot - The snapshot the timeline belongs to
   * @return {VersionDescription} The action kind plus the added/removed counts
   */
  protected describeVersion(
    version: FileVersion,
    versions: FileVersion[],
    snapshot: FileSnapshot,
  ): VersionDescription {
    const index: number = versions.indexOf(version);
    const previous: FileVersion | undefined = index >= 0 ? versions[index + 1] : undefined;
    const previousLines: string[] = previous
      ? previous.getLines()
      : snapshot.getHistoryOriginalStateLines();

    return VersionLabelHelper.describe(previousLines, version.getLines());
  }

  /**
   * Formats the inline line delta shown on a row. Returns an empty string when
   * both added and removed are zero so the row stays clean for no-op captures
   * (e.g. a labeled version pinned at unchanged content).
   *
   * @param {VersionDescription} description - The describe result
   * @return {string} The formatted delta or empty string
   */
  protected formatDelta(description: VersionDescription): string {
    if (description.added === 0 && description.removed === 0) {
      return '';
    }

    return this.plugin.t('modal.version.delta', {
      added: String(description.added),
      removed: String(description.removed),
    });
  }

  /**
   * Opens the history modal in rail-less mode focused on the given version, so
   * the panel is the sole navigator in that session (D4). The file is the one
   * captured at row render time so an active-file switch between render and
   * double-click cannot retarget the modal at a different timeline. A missing
   * snapshot is treated as a no-op by ModalsService.diff (returns false), so
   * the call is safe even on a transient state.
   *
   * @param {TFile} file - The file the version belongs to
   * @param {string} versionId - The version id to focus on open
   */
  protected openInModal(file: TFile, versionId: string): void {
    this.plugin.get<ModalsService>('ModalsService').diff(file, {
      initialBaseId: versionId,
      hideRail: true,
    });
  }
}
