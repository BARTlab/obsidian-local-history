import {
  DEFAULT_LINE_BREAK,
  DiffOutputFormatType,
  DiffViewMode,
  FolderDeltaStatus,
  FolderTimelinePointKind,
} from '@/consts';
import { Inject } from '@/decorators/inject.decorator';
import { FolderTreeComponent, type FolderTreeEntry } from '@/components/folder-tree.component';
import { DiffRenderHelper, type DiffRenderMode } from '@/helpers/diff-render.helper';
import { DomHelper } from '@/helpers/dom.helper';
import {
  FolderDeltaHelper,
  type FolderDeltaResult,
} from '@/helpers/folder-delta.helper';
import {
  FolderTimelineHelper,
  type FolderTimelinePoint,
} from '@/helpers/folder-timeline.helper';
import type LineChangeTrackerPlugin from '@/main';
import type { ModalsService } from '@/services/modals.service';
import type { SnapshotsService } from '@/services/snapshots.service';
import type { VersionActionsService } from '@/services/version-actions.service';
import type { FileSnapshot } from '@/snapshots/file.snapshot';
import type { FileVersion } from '@/snapshots/file.version';
import type { DomElementConfig, FolderToolbarButtonConfig } from '@/types';
import { type App, Modal, Notice, SearchComponent, type TFile, setIcon } from 'obsidian';

/**
 * Modal dialog that displays a folder-level history view (D5). Three columns:
 * a timeline rail on the left, a tree of changed files in the middle, and the
 * diff pane on the right.
 *
 * - The rail is built from {@link FolderTimelineHelper.synthesize}: every
 *   per-file capture / delete / move-in under the root contributes one point
 *   sorted newest-first, grouped by day.
 * - The tree is rendered by {@link FolderTreeComponent}, coloured by
 *   {@link FolderDeltaHelper.compareAt}'s status for the selected timeline
 *   point T (D8 / D9).
 * - The diff pane is rendered by the shared {@link DiffRenderHelper} extracted
 *   in T08 / D6 - the same renderer the file modal uses, so an added file
 *   renders as "everything green" (empty base, full current) and a deleted
 *   file as "everything red" (full base, empty current) without any folder-mode
 *   special-casing.
 *
 * The modal is read-only in T12: toolbar actions (restore / remove / label on
 * the tree-selected file at T) land in T13. The view-mode toggles ARE wired
 * here so the AC5 contract holds: changing the mode re-renders the diff
 * without losing the selected T or the selected file.
 */
export class FolderHistoryModal extends Modal {
  /**
   * Snapshots service used to restore tombstones and read the live map back.
   */
  @Inject('SnapshotsService')
  protected snapshotsService: SnapshotsService;

  /**
   * Modals service used to confirm destructive actions and to prompt for labels.
   */
  @Inject('ModalsService')
  protected modalsService: ModalsService;

  /**
   * Shared restore/remove/label action service, same one the file modal uses.
   */
  @Inject('VersionActionsService')
  protected versionActionsService: VersionActionsService;

  /**
   * Vault-relative folder path the modal is opened against.
   */
  protected readonly rootPath: string;

  /**
   * Snapshots under the folder root the modal was opened against, captured at
   * construction time. The map is keyed by snapshot path so the tree's
   * per-file delta lookups stay constant-time on re-render.
   */
  protected readonly snapshotsByPath: Map<string, FileSnapshot>;

  /**
   * Timeline points synthesised once at open: every per-file capture, delete,
   * and move-in under the root, newest-first. Re-synthesised when the file
   * timeline changes (the toolbar actions in T13 will trigger that).
   */
  protected timeline: FolderTimelinePoint[];

  /**
   * Currently selected timeline point T, in ms. Defaults to the newest point's
   * timestamp; falls back to {@link Date.now} when the timeline is empty (a
   * defensive value, since openFolderHistory rejects empty subtrees upstream
   * so this modal is never opened with no snapshots).
   */
  protected selectedTimestamp: number;

  /**
   * Currently selected display mode; same enum the file modal uses (D6).
   */
  protected currentDisplayMode: DiffRenderMode = DiffOutputFormatType.side;

  /**
   * Left rail container (timeline).
   */
  protected railEl?: HTMLElement;

  /**
   * Middle column wrapper holding the name filter above the scrollable tree.
   */
  protected treeColumnEl?: HTMLElement;

  /**
   * Name-filter search box above the tree (filters file rows by name).
   */
  protected treeSearchEl?: HTMLElement;

  /**
   * Middle tree container, owned by {@link FolderTreeComponent}.
   */
  protected treeEl?: HTMLElement;

  /**
   * Right main column container (toolbar + diff).
   */
  protected mainEl?: HTMLElement;

  /**
   * Top toolbar inside the main column.
   */
  protected toolbarEl?: HTMLElement;

  /**
   * Diff output container, written into by {@link DiffRenderHelper}.
   */
  protected diffContainerEl?: HTMLElement;

  /**
   * Notice above the diff, shown when the selected file has no diff at T.
   */
  protected noticeEl?: HTMLElement;

  /**
   * Header above the side-by-side diff naming each column's content.
   */
  protected columnsHeaderEl?: HTMLElement;

  /**
   * Folder tree component instance, mounted into {@link treeEl}.
   */
  protected readonly tree: FolderTreeComponent;

  /**
   * Mode toggle buttons, kept so the active accent can be flipped.
   */
  protected modeButtons: {
    patch?: HTMLElement;
    inline?: HTMLElement;
    lineByLine?: HTMLElement;
    sideBySide?: HTMLElement;
  } = {};

  /**
   * Restore selected version button, disabled when no file is selected.
   */
  protected restoreSelectedButton?: HTMLButtonElement;

  /**
   * Remove selected version button, disabled when no file is selected.
   */
  protected removeSelectedButton?: HTMLButtonElement;

  /**
   * Label selected version button, disabled when no file is selected.
   */
  protected labelSelectedButton?: HTMLButtonElement;

  /**
   * Restore original (wipe history and revert to baseline) button.
   */
  protected restoreOriginalButton?: HTMLButtonElement;

  /**
   * Remove history (drop the selected file's snapshot) button.
   */
  protected removeHistoryButton?: HTMLButtonElement;

  /**
   * Builds a new folder history modal. The caller is expected to have filtered
   * the snapshots to the folder root (see {@link ModalsService.openFolderHistory})
   * and to bail out when the result is empty, so this constructor does not
   * defensively handle an empty subtree.
   *
   * @param {App} app - The Obsidian app instance
   * @param {LineChangeTrackerPlugin} plugin - The plugin instance
   * @param {string} rootPath - The vault-relative folder path
   * @param {FileSnapshot[]} snapshots - The snapshots under the root
   */
  public constructor(
    public app: App,
    protected plugin: LineChangeTrackerPlugin,
    rootPath: string,
    snapshots: FileSnapshot[],
  ) {
    super(app);

    this.rootPath = rootPath;
    this.snapshotsByPath = new Map<string, FileSnapshot>(
      snapshots.map((snapshot: FileSnapshot): [string, FileSnapshot] => [
        snapshot?.file?.path ?? '',
        snapshot,
      ]),
    );
    this.timeline = FolderTimelineHelper.synthesize(snapshots, rootPath);
    this.selectedTimestamp = this.timeline.length > 0 ? this.timeline[0].timestamp : Date.now();
    this.tree = new FolderTreeComponent();
  }

  /**
   * Lifecycle hook called when the modal opens. Builds the three-column shell,
   * renders the timeline rail, mounts the tree against the current T, and
   * renders the diff for the default-selected file.
   *
   * @override
   */
  public onOpen(): void {
    this.makeUI();

    DomHelper.update(this.modalEl, { classes: { add: ['lct-diff-modal', 'lct-folder-history-modal'] } });

    this.renderTimeline();
    this.refreshTree();
    this.refreshDiff();
  }

  /**
   * Lifecycle hook called when the modal closes. Disposes the tree component
   * so it releases its DOM and references, then clears the modal content.
   *
   * @override
   */
  public onClose(): void {
    this.tree.dispose();
    this.contentEl.empty();
  }

  /**
   * Builds the three-column shell plus the toolbar inside the main column.
   * Reuses the same `.lct-modal-body / .lct-modal-rail / .lct-modal-main`
   * class structure the file modal uses, so the existing flex / scroll
   * policies apply; folder-specific adjustments hang off the
   * `.lct-folder-history-modal` modifier added on the modal element.
   */
  protected makeUI(): void {
    const bodyEl: HTMLElement = DomHelper.create({
      tag: 'div',
      classes: ['lct-modal-body', 'lct-folder-modal-body'],
      container: this.contentEl,
    });

    this.railEl = DomHelper.create({
      tag: 'div',
      classes: ['lct-modal-rail', 'lct-folder-modal-rail'],
      container: bodyEl,
    });

    this.treeColumnEl = DomHelper.create({
      tag: 'div',
      classes: 'lct-folder-modal-tree',
      container: bodyEl,
    });

    this.treeSearchEl = DomHelper.create({
      tag: 'div',
      classes: ['lct-rail-search', 'lct-folder-tree-search'],
      container: this.treeColumnEl,
    });

    this.treeEl = DomHelper.create({
      tag: 'div',
      classes: 'lct-folder-tree-scroll',
      container: this.treeColumnEl,
    });

    this.mainEl = DomHelper.create({
      tag: 'div',
      classes: 'lct-modal-main',
      container: bodyEl,
    });

    this.toolbarEl = DomHelper.create({
      tag: 'div',
      classes: 'lct-modal-toolbar',
      container: this.mainEl,
    });

    this.makeToolbar();

    /**
     * Relocate the native close button into the toolbar, matching the file
     * modal's pattern (see HistoryModal.makeUI) so the floating top-right
     * glyph is replaced by an inline toolbar control.
     */
    const closeButtonEl: HTMLElement | null = this.modalEl.querySelector<HTMLElement>('.modal-close-button');

    if (closeButtonEl) {
      closeButtonEl.classList.remove('mod-raised');
      closeButtonEl.classList.add('clickable-icon');
      this.toolbarEl.appendChild(closeButtonEl);
    }

    this.noticeEl = DomHelper.create({
      tag: 'div',
      classes: ['lct-diff-notice', 'lct-diff-notice-hidden'],
      container: this.mainEl,
    });

    const blockEl: HTMLElement = DomHelper.create({
      tag: 'div',
      classes: 'lct-diff-block',
      container: this.mainEl,
    });

    this.columnsHeaderEl = DomHelper.create({
      tag: 'div',
      classes: ['lct-diff-columns', 'lct-diff-columns-hidden'],
      container: blockEl,
    });

    this.diffContainerEl = DomHelper.create({
      tag: 'div',
      classes: 'diff-container',
      container: blockEl,
    });

    this.tree.mount(this.treeEl, (path: string): void => {
      this.handleTreeSelection(path);
    }, this.plugin);

    this.renderTreeSearch();
  }

  /**
   * Renders the name-filter search box above the tree. Typing filters the tree
   * file rows by name (case-insensitive substring) through
   * {@link FolderTreeComponent.setNameFilter}; it never touches the timeline,
   * the diff, or the selection. The placeholder flows through `plugin.t` with an
   * inline-English fallback (D13 pattern) so it reads sensibly before the key is
   * propagated to every catalog.
   */
  protected renderTreeSearch(): void {
    if (!this.treeSearchEl) {
      return;
    }

    const key: string = 'modal.folder.filter-files';
    const resolved: string = this.plugin.t(key);
    const placeholder: string = resolved && resolved !== key ? resolved : 'Filter files by name';

    new SearchComponent(this.treeSearchEl)
      .setPlaceholder(placeholder)
      .setValue('')
      .onChange((value: string): void => {
        this.tree.setNameFilter(value);
      });
  }

  /**
   * Builds the toolbar in the same shape the file modal uses (T13 / D10):
   * a destructive group (restore-original / remove-history) pinned to the
   * left, a constructive group (restore-selected / remove-selected /
   * label-selected) keyed on the tree-selected file at the picked timeline
   * point T, and the four view-mode toggles right-aligned after them. Every
   * action delegates to {@link VersionActionsService} or to
   * {@link ModalsService}, so behaviour cannot drift from the file modal.
   */
  protected makeToolbar(): void {
    const actionsGroup: HTMLElement = DomHelper.create({
      tag: 'div',
      classes: ['lct-modal-toolbar-group', 'lct-modal-toolbar-actions'],
      container: this.toolbarEl,
    });

    this.restoreOriginalButton = this.makeToolbarButton(actionsGroup, {
      icon: 'rotate-ccw',
      label: this.plugin.t('modal.restore-original'),
      warning: true,
      onClick: async (): Promise<void> => {
        await this.handleRestoreOriginal();
      },
    });

    this.removeHistoryButton = this.makeToolbarButton(actionsGroup, {
      icon: 'trash-2',
      label: this.plugin.t('modal.remove-history'),
      warning: true,
      onClick: async (): Promise<void> => {
        await this.handleRemoveHistory();
      },
    });

    const filterGroup: HTMLElement = DomHelper.create({
      tag: 'div',
      classes: ['lct-modal-toolbar-group', 'lct-modal-toolbar-filter'],
      container: this.toolbarEl,
    });

    this.restoreSelectedButton = this.makeToolbarButton(filterGroup, {
      icon: 'history',
      label: this.plugin.t('modal.restore-selected'),
      onClick: async (): Promise<void> => {
        await this.handleRestoreSelected();
      },
    });

    this.removeSelectedButton = this.makeToolbarButton(filterGroup, {
      icon: 'list-x',
      label: this.plugin.t('modal.remove-selected'),
      onClick: async (): Promise<void> => {
        await this.handleRemoveSelected();
      },
    });

    this.labelSelectedButton = this.makeToolbarButton(filterGroup, {
      icon: 'tag',
      label: this.plugin.t('modal.label-selected'),
      onClick: async (): Promise<void> => {
        await this.handleLabelSelected();
      },
    });

    const modesGroup: HTMLElement = DomHelper.create({
      tag: 'div',
      classes: ['lct-modal-toolbar-group', 'lct-modal-toolbar-modes'],
      container: this.toolbarEl,
    });

    this.modeButtons.patch = this.makeToolbarButton(modesGroup, {
      icon: 'file-text',
      label: this.plugin.t('modal.mode.patch'),
      onClick: (): void => {
        this.setDisplayMode(DiffViewMode.patch);
      },
    });

    this.modeButtons.inline = this.makeToolbarButton(modesGroup, {
      icon: 'pilcrow',
      label: this.plugin.t('modal.mode.inline'),
      onClick: (): void => {
        this.setDisplayMode(DiffViewMode.inline);
      },
    });

    this.modeButtons.lineByLine = this.makeToolbarButton(modesGroup, {
      icon: 'align-justify',
      label: this.plugin.t('modal.mode.line-by-line'),
      onClick: (): void => {
        this.setDisplayMode(DiffOutputFormatType.line);
      },
    });

    this.modeButtons.sideBySide = this.makeToolbarButton(modesGroup, {
      icon: 'columns-2',
      label: this.plugin.t('modal.mode.side-by-side'),
      onClick: (): void => {
        this.setDisplayMode(DiffOutputFormatType.side);
      },
    });

    this.updateModeButtonActiveStates();
    this.updateActionButtonStates();
  }

  /**
   * Syncs the action-button `disabled` flag with the current selection: when no
   * file is selected in the tree (or the selected file has no snapshot in the
   * subtree any more), every selected-* action and the restore-original /
   * remove-history pair are disabled so a click cannot fire against a missing
   * target (AC5). Mirrors the file modal's "disable when nothing is picked"
   * pattern without coupling to the file modal's selectedBaseId.
   */
  protected updateActionButtonStates(): void {
    const path: string | null = this.tree.getSelectedPath();
    const snapshot: FileSnapshot | undefined = path ? this.snapshotsByPath.get(path) : undefined;
    const disabled: boolean = !snapshot;

    [
      this.restoreSelectedButton,
      this.removeSelectedButton,
      this.labelSelectedButton,
      this.restoreOriginalButton,
      this.removeHistoryButton,
    ].forEach((button: HTMLButtonElement | undefined): void => {
      if (!button) {
        return;
      }

      button.disabled = disabled;
      DomHelper.update(button, {
        classes: disabled ? { add: 'is-disabled' } : { remove: 'is-disabled' },
      });
    });
  }

  /**
   * Renders one toolbar icon button: an accessible clickable-icon wearing the
   * Obsidian button look, with an aria-label / tooltip so screen readers and
   * keyboard users have a text label for the icon-only control.
   *
   * @param {HTMLElement} group - The toolbar group to append the button to
   * @param {FolderToolbarButtonConfig} config - The button's icon, label, and handler
   * @return {HTMLButtonElement} The created button
   */
  protected makeToolbarButton(group: HTMLElement, config: FolderToolbarButtonConfig): HTMLButtonElement {
    const button: HTMLButtonElement = DomHelper.create({
      tag: 'button',
      classes: config.warning ? ['clickable-icon', 'lct-toolbar-warning'] : ['clickable-icon'],
      attributes: { 'aria-label': config.label, 'type': 'button' },
      container: group,
      events: {
        click: (): void => {
          void config.onClick();
        },
      },
    });

    setIcon(button, config.icon);

    return button;
  }

  /**
   * Highlights the active mode button. Matches the file modal's accent
   * behaviour (`is-active` on the active control, plain on the others) so the
   * two modals are visually consistent.
   */
  protected updateModeButtonActiveStates(): void {
    const active: HTMLElement | undefined = this.getActiveModeButton();

    Object.values(this.modeButtons).forEach((button: HTMLElement | undefined): void => {
      if (!button) {
        return;
      }

      DomHelper.update(button, {
        classes: button === active ? { add: 'is-active' } : { remove: 'is-active' },
      });
    });
  }

  /**
   * Resolves the toolbar button corresponding to the current display mode.
   *
   * @return {HTMLElement | undefined} The active mode button, or undefined when none
   */
  protected getActiveModeButton(): HTMLElement | undefined {
    switch (this.currentDisplayMode) {
      case DiffViewMode.patch:
        return this.modeButtons.patch;
      case DiffViewMode.inline:
        return this.modeButtons.inline;
      case DiffOutputFormatType.line:
        return this.modeButtons.lineByLine;
      case DiffOutputFormatType.side:
        return this.modeButtons.sideBySide;
      default:
        return undefined;
    }
  }

  /**
   * Sets the active display mode and re-renders the diff against the same
   * selected timeline point and selected file (AC5). A no-op when the mode is
   * already active.
   *
   * @param {DiffRenderMode} mode - The mode to switch to
   */
  protected setDisplayMode(mode: DiffRenderMode): void {
    if (this.currentDisplayMode === mode) {
      return;
    }

    this.currentDisplayMode = mode;
    this.updateModeButtonActiveStates();
    this.refreshDiff();
  }

  /**
   * Renders the timeline rail: a flat list of points grouped by their day
   * key, clickable so the user can pick a new T. Highlights the entry whose
   * timestamp matches the currently selected T.
   */
  protected renderTimeline(): void {
    if (!this.railEl) {
      return;
    }

    type RailGroup = { label: string; points: FolderTimelinePoint[] };

    const groups: RailGroup[] = [];

    this.timeline.forEach((point: FolderTimelinePoint): void => {
      let group: RailGroup | undefined = groups[groups.length - 1];

      if (!group || group.label !== point.dayKey) {
        group = { label: point.dayKey, points: [] };
        groups.push(group);
      }

      group.points.push(point);
    });

    const items: DomElementConfig[] = [];

    groups.forEach((group: RailGroup): void => {
      items.push({ tag: 'div', classes: 'lct-versions-day', text: group.label });

      group.points.forEach((point: FolderTimelinePoint): void => {
        items.push(this.makeTimelineItem(point));
      });
    });

    if (items.length === 0) {
      /**
       * Defensive: openFolderHistory rejects an empty subtree, but a future
       * caller might bypass that gate, so the rail still has a sensible
       * no-results hint instead of an empty column.
       */
      items.push({
        tag: 'div',
        classes: 'lct-versions-no-results',
        text: this.plugin.t('modal.no-versions-match'),
      });
    }

    DomHelper.update(this.railEl, {
      text: null,
      children: [
        {
          tag: 'div',
          classes: 'lct-versions',
          children: [{ tag: 'div', classes: 'lct-versions-list', children: items }],
        },
      ],
    });

    this.paintExternalBadges(this.railEl);
  }

  /**
   * Mirrors the rail / panel post-mount pass: after the DomHelper config tree
   * is mounted, apply Obsidian's `setIcon` to every badge slot the timeline
   * config declared. The icon id is carried as `data-icon` on the wrapper so
   * each badge can be painted without rebuilding the rail imperatively.
   *
   * @param {HTMLElement} container - The rail container to scan
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
   * Whether the given timeline point comes from an external-change capture
   * (D13, T20). Only `'capture'` points map back to a `FileVersion` via
   * `versionId`; `'delete'` and `'move-in'` markers stay non-external. A
   * point whose path or version is no longer in the map (e.g. removed by a
   * destructive action after resync) returns false defensively.
   *
   * @param {FolderTimelinePoint} point - The timeline point to inspect
   * @return {boolean} True when the underlying version is flagged external
   */
  protected isExternalPoint(point: FolderTimelinePoint): boolean {
    if (point.kind !== FolderTimelinePointKind.capture || !point.versionId) {
      return false;
    }

    const snapshot: FileSnapshot | undefined = this.snapshotsByPath.get(point.path);

    if (!snapshot) {
      return false;
    }

    const version: FileVersion | undefined = snapshot.getVersion(point.versionId);

    return version?.isExternal() === true;
  }

  /**
   * Builds the inline external-change badge config used by the timeline rail.
   * Shape and i18n contract match the file modal rail and the recent-changes
   * panel so the badge reads consistently across surfaces (T20 AC1/AC2/AC3).
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
   * Builds a single timeline rail entry: a label describing the event (a
   * capture / delete / move-in plus the file's short name), the time of day
   * inline, and a click that re-pins T and re-renders the tree and diff.
   *
   * @param {FolderTimelinePoint} point - The point to render
   * @return {DomElementConfig} The rail entry element config
   */
  protected makeTimelineItem(point: FolderTimelinePoint): DomElementConfig {
    const active: boolean = this.selectedTimestamp === point.timestamp;
    const shortName: string = this.basename(point.path);
    const kindLabel: string = this.kindLabel(point.kind);
    const time: string = new Date(point.timestamp).toLocaleTimeString();
    const external: boolean = this.isExternalPoint(point);

    const labelChildren: DomElementConfig[] = [
      { tag: 'span', classes: 'lct-version-label', text: shortName },
    ];

    if (external) {
      labelChildren.push(this.makeExternalBadge());
    }

    return {
      tag: 'div',
      classes: active ? ['lct-version-item', 'is-active'] : ['lct-version-item'],
      events: {
        click: (): void => {
          this.selectTimestamp(point.timestamp);
        },
      },
      children: [
        { tag: 'span', classes: 'lct-version-label-row', children: labelChildren },
        { tag: 'span', classes: 'lct-version-meta', text: `${kindLabel}, ${time}` },
      ],
    };
  }

  /**
   * Returns a short, inline-English label for a timeline point kind. The
   * literal strings are propagated across every catalog in T15 (D13 pattern);
   * until then, the labels show as English on every locale.
   *
   * @param {FolderTimelinePoint['kind']} kind - The discriminator
   * @return {string} The human-readable kind label
   */
  protected kindLabel(kind: FolderTimelinePoint['kind']): string {
    switch (kind) {
      case FolderTimelinePointKind.capture:
        return this.plugin.t('modal.folder.timeline.capture');
      case FolderTimelinePointKind.delete:
        return this.plugin.t('modal.folder.timeline.delete');
      case FolderTimelinePointKind.moveIn:
        return this.plugin.t('modal.folder.timeline.move-in');
      default:
        return kind;
    }
  }

  /**
   * Returns the last path segment of a vault-relative path. Used as the rail
   * row's short file label so the column does not overflow on deep paths.
   *
   * @param {string} path - The vault-relative path
   * @return {string} The trailing segment, or the path itself when no slash
   */
  protected basename(path: string): string {
    const lastSlash: number = path.lastIndexOf('/');

    return lastSlash === -1 ? path : path.slice(lastSlash + 1);
  }

  /**
   * Pins a new timeline point T, re-renders the rail (to flip the active
   * highlight), re-colours the tree (the per-file deltas change with T), and
   * re-renders the diff for the currently-selected file at the new T (AC2).
   *
   * @param {number} timestamp - The new selected T
   */
  protected selectTimestamp(timestamp: number): void {
    if (this.selectedTimestamp === timestamp) {
      return;
    }

    this.selectedTimestamp = timestamp;
    this.renderTimeline();
    this.refreshTree();
    this.refreshDiff();
  }

  /**
   * Re-runs `FolderDeltaHelper.compareAt` for every snapshot in the subtree
   * and pushes the resulting entries to the tree component, which preserves
   * the user's expand/collapse state and the previous selection when it is
   * still in the tree (AC2). The tree component falls back to the first file
   * in render order when the previous selection is gone, so the diff pane
   * always has a sensible target.
   */
  protected refreshTree(): void {
    const entries: FolderTreeEntry[] = [];

    this.snapshotsByPath.forEach((snapshot: FileSnapshot, path: string): void => {
      const result: FolderDeltaResult = FolderDeltaHelper.compareAt(snapshot, this.selectedTimestamp);
      const closest: FileVersion | null = this.resolveVersionAtT(snapshot);

      /**
       * The badge follows the version closest to T (D10): if that version was
       * captured from an external change, the tree row carries the marker so
       * the user can spot external states without opening the diff (T20 AC3).
       * Ancestor folders never carry the flag; only file rows do.
       */
      entries.push({
        path,
        status: result.status,
        external: closest?.isExternal() === true,
      });
    });

    this.tree.update({ entries, rootPath: this.rootPath });
  }

  /**
   * Renders the diff for the currently-selected file at the currently-selected
   * T. When no file is selected (an empty tree, or every entry filtered to
   * status `'none'` at this T) the diff pane is replaced with a calm hint
   * instead of leaving stale content on screen.
   */
  protected refreshDiff(): void {
    if (!this.diffContainerEl) {
      return;
    }

    const path: string | null = this.tree.getSelectedPath();
    const snapshot: FileSnapshot | undefined = path ? this.snapshotsByPath.get(path) : undefined;
    const result: FolderDeltaResult | null = snapshot
      ? FolderDeltaHelper.compareAt(snapshot, this.selectedTimestamp)
      : null;

    this.updateDiffNotice(result);
    this.updateColumnsHeader(result);
    this.updateActionButtonStates();

    if (!result) {
      DomHelper.update(this.diffContainerEl, { text: null });

      return;
    }

    DiffRenderHelper.render({
      baseLines: result.base,
      currentLines: result.current,
      lineBreak: snapshot?.lineBreak ?? DEFAULT_LINE_BREAK,
      mode: this.currentDisplayMode,
      container: this.diffContainerEl,
      filePath: path ?? '',
      plugin: this.plugin,
    });
  }

  /**
   * Handler for a tree click: re-renders the diff against the newly-selected
   * file at the current T. The tree component already updates its own
   * `is-active` row, so no rail / tree side effects are needed here.
   *
   * @param {string} _path - The clicked file path
   */
  protected handleTreeSelection(_path: string): void {
    this.refreshDiff();
  }

  /**
   * Resolves the captured version of the given snapshot whose timestamp is
   * closest to (but not after) the picked timeline point T (D10). Returns null
   * when no version qualifies, i.e. when T precedes every captured version: the
   * caller falls back to the synthetic baseline branch in that case so the user
   * can still restore the file's earliest known content.
   *
   * @param {FileSnapshot} snapshot - The file's snapshot
   * @return {FileVersion | null} The closest version at/before T, or null
   */
  protected resolveVersionAtT(snapshot: FileSnapshot): FileVersion | null {
    const versions: FileVersion[] = snapshot.getVersions();
    let candidate: FileVersion | null = null;

    versions.forEach((version: FileVersion): void => {
      if (version.timestamp > this.selectedTimestamp) {
        return;
      }

      if (!candidate || version.timestamp > candidate.timestamp) {
        candidate = version;
      }
    });

    return candidate;
  }

  /**
   * Resolves the file currently focused in the tree back to its snapshot and
   * the per-file delta at T in a single shot, so each handler can early-exit on
   * an empty selection without re-computing the same lookup.
   *
   * @return {{ path: string; snapshot: FileSnapshot; result: FolderDeltaResult } | null}
   */
  protected resolveSelection(): { path: string; snapshot: FileSnapshot; result: FolderDeltaResult } | null {
    const path: string | null = this.tree.getSelectedPath();

    if (!path) {
      return null;
    }

    const snapshot: FileSnapshot | undefined = this.snapshotsByPath.get(path);

    if (!snapshot) {
      return null;
    }

    return {
      path,
      snapshot,
      result: FolderDeltaHelper.compareAt(snapshot, this.selectedTimestamp),
    };
  }

  /**
   * Re-synthesises the timeline from the current snapshot map, clamps the
   * selected T to the nearest remaining point (defaults to the newest one when
   * the original point is gone), and re-renders the rail. Used after a
   * destructive action that removed a version or wiped a file's history so the
   * rail does not surface stale entries.
   */
  protected resyncTimeline(): void {
    this.timeline = FolderTimelineHelper.synthesize(
      Array.from(this.snapshotsByPath.values()),
      this.rootPath,
    );

    if (this.timeline.length === 0) {
      /**
       * The subtree is now empty; the caller closes the modal, but the rail
       * still re-renders into the empty-state hint for safety.
       */
      this.renderTimeline();

      return;
    }

    const stillExists: boolean = this.timeline.some(
      (point: FolderTimelinePoint): boolean => point.timestamp === this.selectedTimestamp,
    );

    if (!stillExists) {
      this.selectedTimestamp = this.timeline[0].timestamp;
    }

    this.renderTimeline();
  }

  /**
   * Handler for the "Restore selected version" toolbar button. The version
   * closest to T is restored on the tree-selected file (D10/AC1). When T
   * precedes every captured version, the synthetic baseline branch writes the
   * `compareAt` base back through {@link SnapshotsService.applyContent} so the
   * file's earliest known content is still restorable. When the selected file
   * is a tombstone with `deletedTimestamp > T` (AC4), the file is re-created
   * at its old path with the content at T and the tombstone is promoted back
   * to a live snapshot in place.
   *
   * @return {Promise<void>}
   */
  protected async handleRestoreSelected(): Promise<void> {
    const selection: { path: string; snapshot: FileSnapshot; result: FolderDeltaResult } | null =
      this.resolveSelection();

    if (!selection) {
      return;
    }

    const confirmed: boolean = await this.modalsService.confirm({
      title: this.plugin.t('modal.confirm.restore-version.title'),
      message: this.plugin.t('modal.confirm.restore-version.message'),
      confirmText: this.plugin.t('modal.confirm.restore-version.button'),
      cancelText: this.plugin.t('modal.confirm.cancel'),
    });

    if (!confirmed) {
      return;
    }

    if (selection.snapshot.isTombstone() && selection.result.status === FolderDeltaStatus.deleted) {
      await this.restoreTombstoneSelection(selection.path, selection.snapshot, selection.result);
      this.resyncTimeline();
      this.refreshTree();
      this.refreshDiff();

      return;
    }

    const file: TFile | null = selection.snapshot.file ?? null;

    if (!file) {
      return;
    }

    const version: FileVersion | null = this.resolveVersionAtT(selection.snapshot);

    if (version) {
      await this.versionActionsService.restoreSelected(file, version.id);
    } else {
      /**
       * Synthetic baseline branch: T precedes every captured version, so the
       * base resolved by FolderDeltaHelper is the history baseline. Reuse the
       * same applyContent path the file modal's ORIGINAL_BASE_ID branch uses
       * so the tracker and the cached state stay in sync after the write.
       */
      const baseLines: string[] = selection.result.base;
      const currentLines: string[] = selection.snapshot.getLastStateLines();

      if (baseLines.join(selection.snapshot.lineBreak) !== currentLines.join(selection.snapshot.lineBreak)) {
        await this.snapshotsService.applyContent(file, baseLines, {
          start: 0,
          removeCount: currentLines.length,
          newLines: baseLines,
        });
      }
    }

    this.refreshTree();
    this.refreshDiff();
  }

  /**
   * Promotes a tombstone back to a live snapshot for AC4: writes the resolved
   * base content to disk at the snapshot's old path through
   * {@link App.vault.create}, attaches the resulting file to the snapshot, and
   * clears the tombstone marker so the entry becomes live in the map without
   * losing its captured versions or history baseline. A best-effort path: on a
   * vault error a Notice surfaces the failure and the tombstone stays as-is so
   * the user can retry.
   *
   * @param {string} path - The vault-relative old path of the deleted file
   * @param {FileSnapshot} snapshot - The tombstone snapshot to promote
   * @param {FolderDeltaResult} result - The compareAt result carrying the base content at T
   * @return {Promise<void>}
   */
  protected async restoreTombstoneSelection(
    path: string,
    snapshot: FileSnapshot,
    result: FolderDeltaResult,
  ): Promise<void> {
    const content: string = result.base.join(snapshot.lineBreak);

    try {
      const created: TFile = await this.app.vault.create(path, content);

      snapshot.file = created;
      snapshot.deletedTimestamp = undefined;
      snapshot.updateState(result.base);
      snapshot.updateChanges();
      this.snapshotsService.forceUpdate();
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (_error) {
      new Notice(this.plugin.t('notice.file-restore-failed'));
    }
  }

  /**
   * Handler for the "Remove selected version" toolbar button. Drops the version
   * closest to T from the tree-selected file's timeline (D10/AC2), then
   * re-synthesises the folder timeline and re-renders the tree so the rail and
   * the per-file delta reflect the removed point. A no-op for a tombstone with
   * no captured version at T (there is nothing to remove without violating the
   * "version closest to T" semantics).
   *
   * @return {Promise<void>}
   */
  protected async handleRemoveSelected(): Promise<void> {
    const selection: { path: string; snapshot: FileSnapshot; result: FolderDeltaResult } | null =
      this.resolveSelection();

    if (!selection) {
      return;
    }

    const version: FileVersion | null = this.resolveVersionAtT(selection.snapshot);

    if (!version) {
      return;
    }

    const confirmed: boolean = await this.modalsService.confirm({
      title: this.plugin.t('modal.confirm.remove-version.title'),
      message: this.plugin.t('modal.confirm.remove-version.message'),
      confirmText: this.plugin.t('modal.confirm.remove-version.button'),
      cancelText: this.plugin.t('modal.confirm.cancel'),
    });

    if (!confirmed) {
      return;
    }

    const file: TFile | null = selection.snapshot.file ?? null;

    /**
     * Tombstones have a null `file` reference (D2 leaves them detached), so the
     * service's getOne lookup would miss. Drop the version directly off the
     * snapshot in that case and notify subscribers ourselves so retention and
     * the rail still see a consistent map.
     */
    if (file) {
      this.versionActionsService.removeSelected(file, version.id);
    } else if (selection.snapshot.removeVersion(version.id)) {
      this.snapshotsService.forceUpdate();
    }

    this.resyncTimeline();
    this.refreshTree();
    this.refreshDiff();
  }

  /**
   * Handler for the "Label selected version" toolbar button. Routes the
   * version closest to T through {@link ModalsService.labelVersion} so the
   * label prompt and the cancel/blank no-op contract match the file modal
   * exactly (D10/AC3). A no-op for a tombstone whose snapshot has no live
   * `file` reference (the modals service resolves the label target by file).
   *
   * @return {Promise<void>}
   */
  protected async handleLabelSelected(): Promise<void> {
    const selection: { path: string; snapshot: FileSnapshot; result: FolderDeltaResult } | null =
      this.resolveSelection();

    if (!selection) {
      return;
    }

    const version: FileVersion | null = this.resolveVersionAtT(selection.snapshot);
    const file: TFile | null = selection.snapshot.file ?? null;

    if (!version || !file) {
      return;
    }

    const labeled: FileVersion | null = await this.modalsService.labelVersion(file, version.id);

    if (!labeled) {
      return;
    }

    this.refreshTree();
    this.refreshDiff();
  }

  /**
   * Handler for the "Restore original" toolbar button. Asks for confirmation
   * and, on consent, rewrites the tree-selected file back to its history
   * baseline and drops its snapshot, mirroring the file modal's destructive
   * action. The folder modal stays open: the tree re-colours so the user can
   * see the rest of the subtree, the now-untracked file simply leaves the
   * delta view.
   *
   * @return {Promise<void>}
   */
  protected async handleRestoreOriginal(): Promise<void> {
    const selection: { path: string; snapshot: FileSnapshot; result: FolderDeltaResult } | null =
      this.resolveSelection();

    if (!selection) {
      return;
    }

    const file: TFile | null = selection.snapshot.file ?? null;

    if (!file) {
      return;
    }

    const confirmed: boolean = await this.modalsService.confirm({
      title: this.plugin.t('modal.confirm.restore.title'),
      message: this.plugin.t('modal.confirm.restore.message'),
      confirmText: this.plugin.t('modal.confirm.restore.button'),
      cancelText: this.plugin.t('modal.confirm.cancel'),
    });

    if (!confirmed) {
      return;
    }

    try {
      const originalContent: string = selection.snapshot.getHistoryOriginalState();

      await this.app.vault.modify(file, originalContent);
      this.snapshotsService.wipeOne(file);
      this.snapshotsByPath.delete(selection.path);

      new Notice(this.plugin.t('notice.file-restored'));
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (_error) {
      new Notice(this.plugin.t('notice.file-restore-failed'));

      return;
    }

    this.resyncTimeline();
    this.refreshTree();
    this.refreshDiff();
  }

  /**
   * Handler for the "Remove history" toolbar button. Asks for confirmation and,
   * on consent, drops the tree-selected file's snapshot through
   * {@link SnapshotsService.wipeOne}, leaving the file's content untouched on
   * disk. The folder modal stays open and the tree is re-coloured so the
   * remaining changed files stay visible.
   *
   * @return {Promise<void>}
   */
  protected async handleRemoveHistory(): Promise<void> {
    const selection: { path: string; snapshot: FileSnapshot; result: FolderDeltaResult } | null =
      this.resolveSelection();

    if (!selection) {
      return;
    }

    const file: TFile | null = selection.snapshot.file ?? null;

    /**
     * Tombstone branch: no live file to write to. Remove-history on a deleted
     * file has no analogue in the file modal (where the modal closes after the
     * wipe), so the folder modal treats it as a no-op for tombstones and lets
     * tombstone retention age the entry out instead.
     */
    if (!file) {
      return;
    }

    const confirmed: boolean = await this.modalsService.confirm({
      title: this.plugin.t('modal.confirm.remove.title'),
      message: this.plugin.t('modal.confirm.remove.message'),
      confirmText: this.plugin.t('modal.confirm.remove.button'),
      cancelText: this.plugin.t('modal.confirm.cancel'),
    });

    if (!confirmed) {
      return;
    }

    this.snapshotsService.wipeOne(file);
    this.snapshotsByPath.delete(selection.path);
    this.resyncTimeline();
    this.refreshTree();
    this.refreshDiff();
  }

  /**
   * Shows or hides the above-diff notice based on the selected file's status
   * at T. The notice is shown when there is no file to diff (empty tree at T),
   * when the file did not change (`'none'`), or for added / deleted variants
   * the user benefits from a one-line explanation alongside the
   * "everything green / red" diff.
   *
   * @param {FolderDeltaResult | null} result - The compareAt result for the selected file
   */
  protected updateDiffNotice(result: FolderDeltaResult | null): void {
    if (!this.noticeEl) {
      return;
    }

    const text: string | null = this.resolveNoticeText(result);

    DomHelper.update(this.noticeEl, {
      text: text ?? null,
      classes: text ? { remove: 'lct-diff-notice-hidden' } : { add: 'lct-diff-notice-hidden' },
    });
  }

  /**
   * Picks the inline-English notice text for the selected file's status, or
   * null when no banner is needed (status `'modified'` reads on its own).
   * The literal strings are propagated across every catalog in T15.
   *
   * @param {FolderDeltaResult | null} result - The compareAt result
   * @return {string | null} The notice text or null when the banner is hidden
   */
  protected resolveNoticeText(result: FolderDeltaResult | null): string | null {
    if (!result) {
      return this.plugin.t('modal.folder.notice.no-file');
    }

    switch (result.status) {
      case FolderDeltaStatus.added:
        return this.plugin.t('modal.folder.notice.added');
      case FolderDeltaStatus.deleted:
        return this.plugin.t('modal.folder.notice.deleted');
      case FolderDeltaStatus.none:
        return this.plugin.t('modal.folder.notice.unchanged');
      default:
        return null;
    }
  }

  /**
   * Toggles the side-by-side column header and, when shown, labels the left
   * column with the picked timeline point and the right column with the
   * current state. Hidden in the single-column modes (patch / inline /
   * line-by-line).
   *
   * @param {FolderDeltaResult | null} result - The compareAt result for the selected file
   */
  protected updateColumnsHeader(result: FolderDeltaResult | null): void {
    if (!this.columnsHeaderEl) {
      return;
    }

    const sideBySide: boolean = this.currentDisplayMode === DiffOutputFormatType.side;

    if (!sideBySide || !result) {
      DomHelper.update(this.columnsHeaderEl, { text: null, classes: { add: 'lct-diff-columns-hidden' } });

      return;
    }

    const pointLabel: string = new Date(this.selectedTimestamp).toLocaleString();

    DomHelper.update(this.columnsHeaderEl, {
      text: null,
      classes: { remove: 'lct-diff-columns-hidden' },
      children: [
        { tag: 'div', classes: 'lct-diff-column-title', text: pointLabel },
        { tag: 'div', classes: 'lct-diff-column-title', text: this.plugin.t('modal.version.current') },
      ],
    });
  }

  /**
   * Returns the timeline this modal was opened against. Exposed for tests
   * and for T13 wiring (the toolbar actions need to know which version is
   * closest to the picked T for the selected file).
   *
   * @return {FolderTimelinePoint[]} The timeline points, newest-first
   */
  public getTimeline(): FolderTimelinePoint[] {
    return this.timeline;
  }

  /**
   * Returns the currently selected timeline point T. Exposed for tests and
   * future T13 wiring.
   *
   * @return {number} The selected T in ms
   */
  public getSelectedTimestamp(): number {
    return this.selectedTimestamp;
  }

  /**
   * Returns the snapshot map keyed by path. Exposed for T13 wiring so the
   * toolbar actions can resolve the tree-selected file back to its snapshot
   * without re-filtering the service map.
   *
   * @return {Map<string, FileSnapshot>} The snapshot map
   */
  public getSnapshotsByPath(): Map<string, FileSnapshot> {
    return this.snapshotsByPath;
  }

  /**
   * Re-runs the per-file delta against the given path at the current T.
   * Exposed for T13 so it can derive the base / current content for the
   * selected file when invoking VersionActionsService.
   *
   * @param {string} path - The vault-relative file path
   * @return {FolderDeltaStatus} The status at T, `'none'` when the path is unknown
   */
  public statusAt(path: string): FolderDeltaStatus {
    const snapshot: FileSnapshot | undefined = this.snapshotsByPath.get(path);

    if (!snapshot) {
      return FolderDeltaStatus.none;
    }

    return FolderDeltaHelper.compareAt(snapshot, this.selectedTimestamp).status;
  }
}
