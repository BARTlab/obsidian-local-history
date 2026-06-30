import {
  DiffOutputFormatType,
  DiffViewMode,
} from '@/consts';
import { Inject } from '@/decorators/inject.decorator';
import { FolderTreeComponent } from '@/components/folder-tree.component';
import * as DomHelper from '@/helpers/dom.helper';
import * as FolderDeltaHelper from '@/helpers/folder-delta.helper';
import { DiffViewState } from '@/modals/diff-view-state';
import {
  FolderActionHandler,
  type FolderActionHost,
  type FolderActionSelection,
} from '@/modals/folder-action-handler';
import { FolderDiffRenderer, type FolderDiffHost } from '@/modals/folder-diff-renderer';
import { FolderSelectionModel } from '@/modals/folder-selection-model';
import { FolderTimelineRenderer, type FolderTimelineHost } from '@/modals/folder-timeline-renderer';
import { HistoryModalShell, type HistoryModalShellRegions } from '@/modals/history-modal-shell';
import { ToolbarBuilder } from '@/modals/toolbar-builder';
import type LineChangeTrackerPlugin from '@/main';
import type { ModalsService } from '@/services/modals.service';
import type { SnapshotsService } from '@/services/snapshots.service';
import type { VersionActionsService } from '@/services/version-actions.service';
import { TOKENS } from '@/services/tokens';
import type { FileSnapshot } from '@/snapshots/file.snapshot';
import type { FileVersion } from '@/snapshots/file.version';
import type {
  DiffRenderMode,
  FolderDeltaResult,
  FolderTimelinePoint,
  FolderTreeEntry
} from '@/types';
import { type App, Modal, SearchComponent } from 'obsidian';

/**
 * Modal dialog that displays a folder-level history view. Three columns:
 * a timeline rail on the left, a tree of changed files in the middle, and the
 * diff pane on the right.
 *
 * - The rail is built from {@link FolderTimelineHelper.synthesize}: every
 *   per-file capture / delete / move-in under the root contributes one point
 *   sorted newest-first, grouped by day.
 * - The tree is rendered by {@link FolderTreeComponent}, coloured by
 *   {@link FolderDeltaHelper.compareAt}'s status for the selected timeline
 *   point T.
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
  /** Snapshots service used to restore tombstones and read the live map back. */
  @Inject(TOKENS.snapshots)
  protected snapshotsService!: SnapshotsService;

  /** Modals service used to confirm destructive actions and to prompt for labels. */
  @Inject(TOKENS.modals)
  protected modalsService!: ModalsService;

  /** Shared restore/remove/label action service, same one the file modal uses. */
  @Inject(TOKENS.versionActions)
  protected versionActionsService!: VersionActionsService;

  /** Vault-relative folder path the modal is opened against. */
  protected readonly rootPath: string;

  /**
   * Snapshots under the folder root the modal was opened against, captured at
   * construction time. The map is keyed by snapshot path so the tree's
   * per-file delta lookups stay constant-time on re-render.
   */
  protected readonly snapshotsByPath: Map<string, FileSnapshot>;

  /**
   * Pure timeline / selection model: owns the synthesised timeline and the
   * selected point T, and answers the closest-version / selection / resync
   * questions off the snapshot map without touching the DOM (unit-testable).
   */
  protected readonly selection: FolderSelectionModel;

  /**
   * Shared diff-view state, reused from the file modal for the mode-button
   * registry, the selected display mode, and the active-mode highlight so the
   * two modals cannot drift. The folder modal has no version-base selection or
   * hunk navigation, so only that display-mode surface is exercised.
   */
  protected readonly viewState: DiffViewState;

  /** Left rail container (timeline). */
  protected railEl?: HTMLElement;

  /** Middle column wrapper holding the name filter above the scrollable tree. */
  protected treeColumnEl?: HTMLElement;

  /** Name-filter search box above the tree (filters file rows by name). */
  protected treeSearchEl?: HTMLElement;

  /** Middle tree container, owned by {@link FolderTreeComponent}. */
  protected treeEl?: HTMLElement;

  /** Right main column container (toolbar + diff). */
  protected mainEl?: HTMLElement;

  /** Top toolbar inside the main column. */
  protected toolbarEl?: HTMLElement;

  /** Diff output container, written into by the {@link FolderDiffRenderer}. */
  protected diffContainerEl?: HTMLElement;

  /** Notice above the diff, shown when the selected file has no diff at T. */
  protected noticeEl?: HTMLElement;

  /** Header above the side-by-side diff naming each column's content. */
  protected columnsHeaderEl?: HTMLElement;

  /** Folder tree component instance, mounted into {@link treeEl}. */
  protected readonly tree: FolderTreeComponent;

  /**
   * Timeline-rail renderer: a plain collaborator the modal owns, reading
   * the live timeline / selected T / snapshot map through a narrow host port
   * and reporting a picked T back so the modal re-pins it.
   */
  protected readonly timelineRenderer: FolderTimelineRenderer;

  /**
   * Diff-pane renderer: a plain collaborator the modal owns, rendering
   * the per-file delta diff, the above-diff notice, and the side-by-side
   * column header for the tree-selected file at the selected T. Reads the live
   * containers / mode / T / selection through a narrow host port and signals
   * each render back so the modal re-syncs the toolbar action-button states.
   */
  protected readonly diffRenderer: FolderDiffRenderer;

  /**
   * Toolbar-action collaborator: a plain collaborator the modal owns,
   * owning the five async toolbar actions (restore / remove / label selected,
   * restore-original, remove-history) and the deleted-file tombstone restore.
   * Reads the live selection / closest version through a narrow host port and
   * drives the post-action rail / tree / diff re-render back through it, so the
   * modal stays free of the destructive-action bodies.
   */
  protected readonly actionHandler: FolderActionHandler;

  /** Restore selected version button, disabled when no file is selected. */
  protected restoreSelectedButton?: HTMLButtonElement;

  /** Remove selected version button, disabled when no file is selected. */
  protected removeSelectedButton?: HTMLButtonElement;

  /** Label selected version button, disabled when no file is selected. */
  protected labelSelectedButton?: HTMLButtonElement;

  /** Restore original (wipe history and revert to baseline) button. */
  protected restoreOriginalButton?: HTMLButtonElement;

  /** Remove history (drop the selected file's snapshot) button. */
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
    public plugin: LineChangeTrackerPlugin,
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
    this.selection = new FolderSelectionModel(snapshots, rootPath);
    this.viewState = new DiffViewState({
      diffContainer: (): HTMLElement | undefined => this.diffContainerEl,
      getHunks: () => [],
    });
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
   * the file modal's VersionList / GutterRevert collaborators use:
   * the renderer never sees the modal's protected fields directly.
   *
   * @return {FolderTimelineHost} The host port for the timeline renderer
   */
  protected makeTimelineHost(): FolderTimelineHost {
    return {
      plugin: this.plugin,
      railEl: (): HTMLElement | undefined => this.railEl,
      timeline: (): FolderTimelinePoint[] => this.selection.timeline,
      selectedTimestamp: (): number => this.selection.selectedTimestamp,
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
   * Mirrors the host-port pattern the timeline renderer and the file
   * modal's collaborators use: the renderer never sees the modal's
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
      displayMode: (): DiffRenderMode => this.viewState.currentDisplayMode,
      selectedTimestamp: (): number => this.selection.selectedTimestamp,
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
   * pattern the timeline and diff renderers use: the handler never
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
      resolveSelection: (): FolderActionSelection | null =>
        this.selection.resolveSelection(this.tree.getSelectedPath(), this.snapshotsByPath),
      resolveVersionAtT: (snapshot: FileSnapshot): FileVersion | null => this.selection.resolveVersionAtT(snapshot),
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
   * Builds the three-column shell plus the toolbar inside the main column
   * through the shared {@link HistoryModalShell}. The shell owns the body / main
   * / toolbar / notice / diff-block spine and the close-button relocation both
   * modals share; this modal supplies the folder body modifier and the rail plus
   * the middle tree column, then fills the toolbar, mounts the tree, and renders
   * the tree search. Folder-specific adjustments hang off the
   * `.lct-folder-history-modal` modifier added on the modal element.
   */
  protected makeUI(): void {
    const shell: HistoryModalShell = new HistoryModalShell(this.contentEl, this.modalEl);

    const regions: HistoryModalShellRegions = shell.build({
      bodyModifier: ['lct-folder-modal-body'],
      buildColumns: (bodyEl: HTMLElement): void => this.buildNavColumns(bodyEl),
    });

    this.mainEl = regions.mainEl;
    this.toolbarEl = regions.toolbarEl;
    this.noticeEl = regions.noticeEl;
    this.columnsHeaderEl = regions.columnsHeaderEl;
    this.diffContainerEl = regions.diffContainerEl;

    this.makeToolbar();
    shell.relocateCloseButton(this.toolbarEl);

    if (this.treeEl) {
      this.tree.mount(this.treeEl, (path: string): void => {
        this.handleTreeSelection(path);
      }, this.plugin);
    }

    this.renderTreeSearch();
  }

  /**
   * Builds the folder modal's two navigation columns into the shell body: the
   * timeline rail on the left and the middle tree column (a name-filter search
   * above the scrollable file tree). Reuses the same `.lct-modal-rail` structure
   * the file modal uses, with folder modifiers for the folder-specific layout.
   *
   * @param {HTMLElement} bodyEl - The shell body the columns are appended to
   */
  protected buildNavColumns(bodyEl: HTMLElement): void {
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
  }

  /**
   * Renders the name-filter search box above the tree. Typing filters the tree
   * file rows by name (case-insensitive substring) through
   * {@link FolderTreeComponent.setNameFilter}; it never touches the timeline,
   * the diff, or the selection. The placeholder flows through `plugin.t` with an
   * inline-English fallback so it reads sensibly before the key is
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
   * Builds the toolbar in the same shape the file modal uses:
   * a destructive group (restore-original / remove-history) pinned to the
   * left, a constructive group (restore-selected / remove-selected /
   * label-selected) keyed on the tree-selected file at the picked timeline
   * point T, and the four view-mode toggles right-aligned after them. Every
   * action delegates to {@link VersionActionsService} or to
   * {@link ModalsService}, so behaviour cannot drift from the file modal.
   */
  protected makeToolbar(): void {
    const toolbarEl: HTMLElement | undefined = this.toolbarEl;

    if (!toolbarEl) {
      return;
    }

    const builder: ToolbarBuilder = new ToolbarBuilder(toolbarEl);

    const actionsGroup: HTMLElement = builder.addGroup('lct-modal-toolbar-actions');

    this.restoreOriginalButton = builder.addButton(actionsGroup, {
      icon: 'rotate-ccw',
      label: this.plugin.t('modal.restore-original'),
      warning: true,
      onClick: async (): Promise<void> => {
        await this.actionHandler.handleRestoreOriginal();
      },
    });

    this.removeHistoryButton = builder.addButton(actionsGroup, {
      icon: 'trash-2',
      label: this.plugin.t('modal.remove-history'),
      warning: true,
      onClick: async (): Promise<void> => {
        await this.actionHandler.handleRemoveHistory();
      },
    });

    const filterGroup: HTMLElement = builder.addGroup('lct-modal-toolbar-filter');

    this.restoreSelectedButton = builder.addButton(filterGroup, {
      icon: 'history',
      label: this.plugin.t('modal.restore-selected'),
      onClick: async (): Promise<void> => {
        await this.actionHandler.handleRestoreSelected();
      },
    });

    this.removeSelectedButton = builder.addButton(filterGroup, {
      icon: 'list-x',
      label: this.plugin.t('modal.remove-selected'),
      onClick: async (): Promise<void> => {
        await this.actionHandler.handleRemoveSelected();
      },
    });

    this.labelSelectedButton = builder.addButton(filterGroup, {
      icon: 'tag',
      label: this.plugin.t('modal.label-selected'),
      onClick: async (): Promise<void> => {
        await this.actionHandler.handleLabelSelected();
      },
    });

    const modesGroup: HTMLElement = builder.addGroup('lct-modal-toolbar-modes');

    this.viewState.modeButtons.patch = builder.addButton(modesGroup, {
      icon: 'file-text',
      label: this.plugin.t('modal.mode.patch'),
      onClick: (): void => {
        this.setDisplayMode(DiffViewMode.patch);
      },
    });

    this.viewState.modeButtons.inline = builder.addButton(modesGroup, {
      icon: 'pilcrow',
      label: this.plugin.t('modal.mode.inline'),
      onClick: (): void => {
        this.setDisplayMode(DiffViewMode.inline);
      },
    });

    this.viewState.modeButtons.lineByLine = builder.addButton(modesGroup, {
      icon: 'align-justify',
      label: this.plugin.t('modal.mode.line-by-line'),
      onClick: (): void => {
        this.setDisplayMode(DiffOutputFormatType.line);
      },
    });

    this.viewState.modeButtons.sideBySide = builder.addButton(modesGroup, {
      icon: 'columns-2',
      label: this.plugin.t('modal.mode.side-by-side'),
      onClick: (): void => {
        this.setDisplayMode(DiffOutputFormatType.side);
      },
    });

    this.viewState.updateButtonActiveStates();
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
   * Sets the active display mode and re-renders the diff against the same
   * selected timeline point and selected file (AC5). A no-op when the mode is
   * already active.
   *
   * @param {DiffRenderMode} mode - The mode to switch to
   */
  protected setDisplayMode(mode: DiffRenderMode): void {
    if (this.viewState.currentDisplayMode === mode) {
      return;
    }

    this.viewState.currentDisplayMode = mode;
    this.viewState.updateButtonActiveStates();
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
    if (this.selection.selectedTimestamp === timestamp) {
      return;
    }

    this.selection.select(timestamp);
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
      const result: FolderDeltaResult = FolderDeltaHelper.compareAt(snapshot, this.selection.selectedTimestamp);
      const closest: FileVersion | null = this.selection.resolveVersionAtT(snapshot);

      /**
       * The badge follows the version closest to T: if that version was
       * captured from an external change, the tree row carries the marker so
       * the user can spot external states without opening the diff.
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
   * T by delegating to the {@link FolderDiffRenderer} collaborator. The
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
   * Re-synthesises the timeline through the pure {@link FolderSelectionModel}
   * (clamping the selected T to the nearest remaining point) and re-renders the
   * rail. Used after a destructive action that removed a version or wiped a
   * file's history so the rail does not surface stale entries. The render also
   * covers the now-empty subtree, where the rail falls back to its empty-state
   * hint before the caller closes the modal.
   */
  protected resyncTimeline(): void {
    this.selection.resync(this.snapshotsByPath, this.rootPath);
    this.timelineRenderer.render();
  }
}
