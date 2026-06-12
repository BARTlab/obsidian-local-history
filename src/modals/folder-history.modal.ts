import {
  DiffOutputFormatType,
  DiffViewMode,
  FolderDeltaStatus,
} from '@/consts';
import { Inject } from '@/decorators/inject.decorator';
import { FolderTreeComponent } from '@/components/folder-tree.component';
import { DomHelper } from '@/helpers/dom.helper';
import { FolderDeltaHelper } from '@/helpers/folder-delta.helper';
import { FolderTimelineHelper } from '@/helpers/folder-timeline.helper';
import {
  FolderActionHandler,
  type FolderActionHost,
  type FolderActionSelection,
} from '@/modals/folder-action-handler';
import { FolderDiffRenderer, type FolderDiffHost } from '@/modals/folder-diff-renderer';
import { FolderTimelineRenderer, type FolderTimelineHost } from '@/modals/folder-timeline-renderer';
import type LineChangeTrackerPlugin from '@/main';
import type { ModalsService } from '@/services/modals.service';
import type { SnapshotsService } from '@/services/snapshots.service';
import type { VersionActionsService } from '@/services/version-actions.service';
import type { FileSnapshot } from '@/snapshots/file.snapshot';
import type { FileVersion } from '@/snapshots/file.version';
import type {
  DiffRenderMode,
  FolderDeltaResult,
  FolderToolbarButtonConfig,
  FolderTimelinePoint,
  FolderTreeEntry
} from '@/types';
import { type App, Modal, SearchComponent, setIcon } from 'obsidian';

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
 * - The diff pane is rendered by the {@link FolderDiffRenderer} collaborator,
 *   which delegates to the shared `DiffRenderHelper` - the same renderer the
 *   file modal uses, so an added file renders as "everything green" (empty
 *   base, full current) and a deleted file as "everything red" (full base,
 *   empty current) without any folder-mode special-casing.
 *
 * Toolbar actions (restore / remove / label on the tree-selected file at the
 * selected timeline point T) are handled by the {@link FolderActionHandler}
 * collaborator, which drives the post-action rail / tree / diff re-render back
 * through the modal. The view-mode toggles re-render the diff in place: changing
 * the mode never loses the selected T or the selected file.
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
   * timeline changes (the toolbar actions trigger that).
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
   * Diff output container, written into by the {@link FolderDiffRenderer}.
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
   * Timeline-rail renderer (T07): a plain collaborator the modal owns, reading
   * the live timeline / selected T / snapshot map through a narrow host port
   * and reporting a picked T back so the modal re-pins it.
   */
  protected readonly timelineRenderer: FolderTimelineRenderer;

  /**
   * Diff-pane renderer (T08): a plain collaborator the modal owns, rendering
   * the per-file delta diff, the above-diff notice, and the side-by-side
   * column header for the tree-selected file at the selected T. Reads the live
   * containers / mode / T / selection through a narrow host port and signals
   * each render back so the modal re-syncs the toolbar action-button states.
   */
  protected readonly diffRenderer: FolderDiffRenderer;

  /**
   * Toolbar-action collaborator (T09): a plain collaborator the modal owns,
   * owning the five async toolbar actions (restore / remove / label selected,
   * restore-original, remove-history) and the deleted-file tombstone restore.
   * Reads the live selection / closest version through a narrow host port and
   * drives the post-action rail / tree / diff re-render back through it, so the
   * modal stays free of the destructive-action bodies.
   */
  protected readonly actionHandler: FolderActionHandler;

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
        snapshot?.file?.path ?? snapshot?.path ?? '',
        snapshot,
      ]),
    );
    this.timeline = FolderTimelineHelper.synthesize(snapshots, rootPath);
    this.selectedTimestamp = this.timeline.length > 0 ? this.timeline[0].timestamp : Date.now();
    this.tree = new FolderTreeComponent();
    this.timelineRenderer = new FolderTimelineRenderer(this.makeTimelineHost());
    this.diffRenderer = new FolderDiffRenderer(this.makeDiffHost());
    this.actionHandler = new FolderActionHandler(this.makeActionHost());
  }

  /**
   * Builds the narrow host port the {@link FolderTimelineRenderer} reads the
   * modal's shared state through. The accessors are lazy so the renderer always
   * sees the live timeline, selected T, rail container, and snapshot map, and
   * the `selectTimestamp` callback routes a picked point back through the
   * modal's own re-pin path (rail + tree + diff). Mirrors the host-port pattern
   * the file modal's VersionList / GutterRevert collaborators use (T04 / T05):
   * the renderer never sees the modal's protected fields directly.
   *
   * @return {FolderTimelineHost} The host port for the timeline renderer
   */
  protected makeTimelineHost(): FolderTimelineHost {
    return {
      plugin: this.plugin,
      railEl: (): HTMLElement | undefined => this.railEl,
      timeline: (): FolderTimelinePoint[] => this.timeline,
      selectedTimestamp: (): number => this.selectedTimestamp,
      snapshotsByPath: (): Map<string, FileSnapshot> => this.snapshotsByPath,
      selectTimestamp: (timestamp: number): void => {
        this.selectTimestamp(timestamp);
      },
    };
  }

  /**
   * Builds the narrow host port the {@link FolderDiffRenderer} reads the modal's
   * diff-pane state through. The accessors are lazy so the renderer always sees
   * the live diff / notice / columns-header containers, the selected display
   * mode, the selected T, the tree's selected file, and the snapshot map; the
   * `onDiffRendered` callback routes the post-render refresh of the toolbar
   * action-button states back to the modal, which still owns the toolbar.
   * Mirrors the host-port pattern the timeline renderer (T07) and the file
   * modal's collaborators (T04 / T05) use: the renderer never sees the modal's
   * protected fields directly.
   *
   * @return {FolderDiffHost} The host port for the diff renderer
   */
  protected makeDiffHost(): FolderDiffHost {
    return {
      plugin: this.plugin,
      diffContainerEl: (): HTMLElement | undefined => this.diffContainerEl,
      noticeEl: (): HTMLElement | undefined => this.noticeEl,
      columnsHeaderEl: (): HTMLElement | undefined => this.columnsHeaderEl,
      displayMode: (): DiffRenderMode => this.currentDisplayMode,
      selectedTimestamp: (): number => this.selectedTimestamp,
      selectedPath: (): string | null => this.tree.getSelectedPath(),
      snapshotsByPath: (): Map<string, FileSnapshot> => this.snapshotsByPath,
      onDiffRendered: (): void => {
        this.updateActionButtonStates();
      },
    };
  }

  /**
   * Builds the narrow host port the {@link FolderActionHandler} reads the modal's
   * action state through. The services and app are passed straight through; the
   * selection / closest-version derivations and the snapshot-map mutation +
   * rail / tree / diff re-render are routed back to the modal so the handler
   * never owns the timeline or the snapshot map directly. Mirrors the host-port
   * pattern the timeline (T07) and diff (T08) renderers use: the handler never
   * sees the modal's protected fields directly.
   *
   * @return {FolderActionHost} The host port for the action handler
   */
  protected makeActionHost(): FolderActionHost {
    return {
      app: this.app,
      plugin: this.plugin,
      modalsService: this.modalsService,
      versionActionsService: this.versionActionsService,
      snapshotsService: this.snapshotsService,
      resolveSelection: (): FolderActionSelection | null => this.resolveSelection(),
      resolveVersionAtT: (snapshot: FileSnapshot): FileVersion | null => this.resolveVersionAtT(snapshot),
      removeFromMap: (path: string): void => {
        this.snapshotsByPath.delete(path);
      },
      resyncTimeline: (): void => {
        this.resyncTimeline();
      },
      refreshTree: (): void => {
        this.refreshTree();
      },
      refreshDiff: (): void => {
        this.refreshDiff();
      },
    };
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

    this.timelineRenderer.render();
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
   * Builds the toolbar in the same shape the file modal uses (D10):
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
        await this.actionHandler.handleRestoreOriginal();
      },
    });

    this.removeHistoryButton = this.makeToolbarButton(actionsGroup, {
      icon: 'trash-2',
      label: this.plugin.t('modal.remove-history'),
      warning: true,
      onClick: async (): Promise<void> => {
        await this.actionHandler.handleRemoveHistory();
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
        await this.actionHandler.handleRestoreSelected();
      },
    });

    this.removeSelectedButton = this.makeToolbarButton(filterGroup, {
      icon: 'list-x',
      label: this.plugin.t('modal.remove-selected'),
      onClick: async (): Promise<void> => {
        await this.actionHandler.handleRemoveSelected();
      },
    });

    this.labelSelectedButton = this.makeToolbarButton(filterGroup, {
      icon: 'tag',
      label: this.plugin.t('modal.label-selected'),
      onClick: async (): Promise<void> => {
        await this.actionHandler.handleLabelSelected();
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
    this.timelineRenderer.render();
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
   * T by delegating to the {@link FolderDiffRenderer} collaborator (T08). The
   * renderer reads the live containers / mode / T / selection through its host
   * port and calls back into {@link updateActionButtonStates} after each render
   * so the toolbar stays in sync.
   */
  protected refreshDiff(): void {
    this.diffRenderer.refresh();
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
      this.timelineRenderer.render();

      return;
    }

    const stillExists: boolean = this.timeline.some(
      (point: FolderTimelinePoint): boolean => point.timestamp === this.selectedTimestamp,
    );

    if (!stillExists) {
      this.selectedTimestamp = this.timeline[0].timestamp;
    }

    this.timelineRenderer.render();
  }

  /**
   * Returns the timeline this modal was opened against. Exposed for tests
   * and for the toolbar actions, which need to know which version is closest
   * to the picked T for the selected file.
   *
   * @return {FolderTimelinePoint[]} The timeline points, newest-first
   */
  public getTimeline(): FolderTimelinePoint[] {
    return this.timeline;
  }

  /**
   * Returns the currently selected timeline point T. Exposed for tests and
   * the toolbar actions.
   *
   * @return {number} The selected T in ms
   */
  public getSelectedTimestamp(): number {
    return this.selectedTimestamp;
  }

  /**
   * Returns the snapshot map keyed by path. Exposed so the toolbar
   * actions can resolve the tree-selected file back to its snapshot
   * without re-filtering the service map.
   *
   * @return {Map<string, FileSnapshot>} The snapshot map
   */
  public getSnapshotsByPath(): Map<string, FileSnapshot> {
    return this.snapshotsByPath;
  }

  /**
   * Re-runs the per-file delta against the given path at the current T.
   * Exposed so the toolbar actions can derive the base / current content
   * for the selected file when invoking VersionActionsService.
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
