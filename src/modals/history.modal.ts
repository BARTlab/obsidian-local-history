import { DiffOutputFormatType, DiffViewMode, NavigationDirection, ORIGINAL_BASE_ID } from '@/consts';
import { Inject } from '@/decorators/inject.decorator';
import { DiffHeaderController } from '@/modals/diff-header-controller';
import { DiffPresenter, type DiffPresenterHost } from '@/modals/diff-presenter';
import { DiffScrollSync } from '@/modals/diff-scroll-sync';
import { DiffViewState, type DiffViewStateHost } from '@/modals/diff-view-state';
import { GutterRevertHandler, type GutterRevertHost } from '@/modals/gutter-revert-handler';
import { HistoryModalShell, type HistoryModalShellRegions } from '@/modals/history-modal-shell';
import { KeyboardController, type KeyboardControllerHost } from '@/modals/keyboard-controller';
import { ToolbarBuilder } from '@/modals/toolbar-builder';
import { VersionList, type VersionListHost } from '@/components/version-list.component';
import * as DomHelper from '@/helpers/dom.helper';
import type LineChangeTrackerPlugin from '@/main';
import type { ModalsService } from '@/services/modals.service';
import type { SnapshotsService } from '@/services/snapshots.service';
import type { VersionActionsService } from '@/services/version-actions.service';
import { TOKENS } from '@/services/tokens';
import type { FileSnapshot } from '@/snapshots/file.snapshot';
import type { FileVersion } from '@/snapshots/file.version';
import type {
  DiffRenderMode,
  HistoryModalOpenOptions,
  HTMLElementWithScrollSync,
  VersionRemoveResult
} from '@/types';
import type * as Diff from 'diff';
import { type App, Modal, Notice, SearchComponent, type TFile } from 'obsidian';

/**
 * Modal dialog that displays the history of changes for a file.
 * Shows a diff view comparing the original state with the current state.
 * Provides options to view the diff in different formats and to remove the file's history.
 *
 * @extends Modal
 */
export class HistoryModal extends Modal {
  @Inject(TOKENS.snapshots)
  protected snapshotsService!: SnapshotsService;

  @Inject(TOKENS.modals)
  protected modalsService!: ModalsService;

  /**
   * Shared owner of restore/remove/put-label actions on the version timeline.
   * The modal routes these through the service so the panel (and any future
   * surface) executes the same implementation.
   */
  @Inject(TOKENS.versionActions)
  protected versionActionsService!: VersionActionsService;

  /**
   * Reference to the current diff container element.
   * Used for cleanup operations when switching between diff modes.
   */
  protected diffContainerEl?: HTMLElementWithScrollSync;

  /**
   * Side-by-side scroll-synchronisation collaborator the modal owns. It
   * carries the deferred-setup timer and the per-container listener cleanup
   * that previously lived on the modal; it reads the live diff container back
   * through the resolver so it can bail when the container is swapped mid-flight.
   */
  protected readonly scrollSync: DiffScrollSync = new DiffScrollSync(
    (): HTMLElementWithScrollSync | undefined => this.diffContainerEl,
  );

  /**
   * Version-list collaborator the modal owns. It renders the left-rail
   * timeline, walks the selection with the keyboard, and derives the per-row
   * labels/deltas; it reads the live selection and the search/hide-identical
   * filters back through the host adapter below and reports a selection change
   * via `selectBase` so the modal keeps coordinating the diff render.
   */
  protected readonly versionList: VersionList = new VersionList(this.makeVersionListHost());

  /**
   * Gutter-revert collaborator the modal owns. It decorates each rendered
   * hunk with an anchor marker and an inline revert affordance, resolves the
   * anchor row across every diff render mode, and reverts a single hunk on click;
   * it reads the live diff container, display mode, and hunks back through the
   * host adapter below and reports a completed revert via `onReverted` so the
   * modal drops the stale focus and re-renders the active diff.
   */
  protected readonly gutterReverts: GutterRevertHandler = new GutterRevertHandler(this.makeGutterRevertHost());

  /**
   * Left rail container of the three-pane shell. Hosts the version timeline
   * (and, in a later task, the content search above it).
   */
  protected railEl?: HTMLElement;

  /**
   * Top toolbar container of the three-pane shell. Hosts the view-mode and
   * action controls above the diff.
   */
  protected toolbarEl?: HTMLElement;

  /**
   * Main pane container of the three-pane shell. Hosts the toolbar and the diff
   * output. The next/previous navigation now walks the diff rows directly.
   */
  protected mainEl?: HTMLElement;

  /**
   * Banner shown above the diff when the selected base resolves to the same
   * content as the current state, so every view mode (including the blank
   * diff2html output) explains why no changes are rendered.
   */
  protected noticeEl?: HTMLElement;

  /**
   * Header above the side-by-side diff that labels which version each column
   * shows: the picked base on the left, the current state on the right. Hidden
   * in the other view modes, which are single-column.
   */
  protected columnsHeaderEl?: HTMLElement;

  /**
   * Container element holding the content-search box above the version list in
   * the left rail.
   */
  protected searchEl?: HTMLElement;

  /**
   * Container element holding the version timeline list, rebuilt to reflect the
   * selected base.
   */
  protected versionsEl?: HTMLElement;

  /**
   * Diff-view-state collaborator the modal owns. It holds the diff-view
   * state - the selected base, the active display mode, the focused hunk index,
   * the hide-identical rail filter, and the content-search query - together with
   * the toolbar mode/nav button registries, and owns the active-mode highlight,
   * the next/previous difference walk, and the nav-button enablement; it reads
   * the live diff container and hunks back through the host adapter below so the
   * focus and button state always match the rendered diff. The modal reads and
   * mutates the state through this reference while coordinating the renders.
   */
  protected readonly viewState: DiffViewState = new DiffViewState(this.makeDiffViewStateHost());

  /**
   * Diff-header collaborator the modal owns: it reveals or hides the above-diff
   * notice and the side-by-side column header, the DOM logic both history modals
   * share. The modal decides when each is shown and with what label; the
   * controller owns the reveal/hide mechanics so the two modals stay in lockstep.
   */
  protected readonly diffHeader: DiffHeaderController = new DiffHeaderController(
    (): HTMLElement | undefined => this.noticeEl,
    (): HTMLElement | undefined => this.columnsHeaderEl,
    this.plugin,
  );

  /**
   * Diff-presentation collaborator the modal owns: it holds the diff render
   * pipeline behind refresh(mode) - base-content resolution, hunk computation,
   * the four render modes, and the notice/columns-header updates driven through
   * the shared DiffHeaderController. The modal decides when to render and routes
   * the toolbar action-button state back through the host, while the presenter
   * reads the live diff container and drives the owned collaborators.
   */
  protected readonly diffPresenter: DiffPresenter = new DiffPresenter(this.makeDiffPresenterHost());

  /**
   * Keyboard-navigation collaborator the modal owns: it handles the version-rail
   * and diff-pane keydown events (arrow/Home/End/Page navigation, Delete). It
   * walks the selection through the owned VersionList and reads the live diff
   * container back through the host, routing the confirm-before-delete flow to
   * the modal.
   */
  protected readonly keyboard: KeyboardController = new KeyboardController(this.makeKeyboardControllerHost());

  /**
   * Toolbar button toggling hideIdenticalVersions, kept so its active (is-active)
   * state can be flipped when the filter changes.
   */
  protected hideIdenticalButton?: HTMLElement;

  /**
   * Toolbar button that rewrites the file to the selected base, kept so it can
   * be disabled when the selected base already equals the current state (there
   * is nothing to restore).
   */
  protected restoreSelectedButton?: HTMLElement;

  /**
   * Toolbar button that deletes the selected version from the timeline, kept so
   * it can be disabled when the synthetic baseline is selected (only a real
   * captured version can be removed).
   */
  protected removeSelectedButton?: HTMLElement;

  /**
   * Toolbar button that labels the selected version, kept so it can be disabled
   * when the synthetic baseline is selected (only a real captured version can
   * carry a custom label).
   */
  protected labelSelectedButton?: HTMLElement;

  /**
   * Open options applied on the next onOpen call: an optional `initialBaseId`
   * to pre-select on open and an optional `hideRail` to render in rail-less
   * mode. With no options the modal behaves exactly as before.
   */
  protected readonly options: HistoryModalOpenOptions;

  /**
   * Creates a new instance of HistoryModal.
   *
   * @param {App} app - The Obsidian app instance
   * @param {LineChangeTrackerPlugin} plugin - The plugin instance
   * @param {FileSnapshot} snapshot - The file snapshot to display history for
   * @param {HistoryModalOpenOptions} options - Optional open options (initialBaseId, hideRail)
   */
  public constructor(
    public app: App,
    public plugin: LineChangeTrackerPlugin,
    protected snapshot: FileSnapshot,
    options?: HistoryModalOpenOptions,
  ) {
    super(app);

    this.options = options ?? {};
  }

  /**
   * Lifecycle method called when the modal is opened.
   * Sets up the UI, adds CSS classes, sets the title based on the snapshot state,
   * and renders the diff view.
   * Does nothing if no snapshot is provided.
   *
   * @override
   */
  public onOpen(): void {
    if (!this.snapshot) {
      return;
    }

    /**
     * Open on the latest captured version ("what changed since the last save"),
     * or on the Original entry when no snapshots exist yet.
     */
    this.viewState.selectedBaseId = this.getInitialBaseId();

    this.makeUI();

    // Increase the size of the modal window.
    DomHelper.update(
      this.modalEl,
      { classes: { add: 'lct-diff-modal' } }
    );

    this.diffPresenter.refresh(DiffOutputFormatType.side);
  }

  /**
   * Lifecycle method called when the modal is closed.
   * Cleans up by emptying the content element and removing scroll sync listeners.
   *
   * @override
   */
  public onClose(): void {
    this.scrollSync.cleanup();
    this.contentEl.empty();
  }

  /**
   * Restores the file to its original state and resets the history tracking.
   * Writes the original content back to the file and clears the snapshot.
   */
  protected async restoreOriginalFile(): Promise<void> {
    if (!this.snapshot) {
      return;
    }

    try {
      const originalContent: string = this.snapshot.content.getHistoryOriginalState();
      // snapshot.file is non-null when the snapshot was opened from a live file
      const file: TFile | null | undefined = this.snapshot.file;

      if (!file) {
        return;
      }

      await this.app.vault.modify(file, originalContent);
      this.snapshotsService.wipeOne(file);

      new Notice(this.plugin.t('notice.file-restored'));

      this.close();
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (_error) {
      new Notice(this.plugin.t('notice.file-restore-failed'));
    }
  }

  /**
   * Rewrites the whole file to the currently selected base (a picked version,
   * the latest snapshot, or the original). Unlike restoreOriginalFile this keeps
   * the history baseline and the version timeline intact, so it is a plain
   * content revert to a chosen point rather than a reset: the prior content
   * simply becomes the next captured version on the following edit. Reuses the
   * same SnapshotsService.applyContent path the per-hunk revert uses, scoping the
   * "block" to the entire file. A no-op when the base already equals the current
   * state (the button is disabled in that case anyway). The modal stays open and
   * the active view is re-rendered so the diff reflects the new content.
   */
  protected async restoreSelectedVersion(): Promise<void> {
    const file: TFile | undefined = this.snapshot?.file ?? undefined;

    if (!file || this.diffPresenter.isBaseSameCurrent()) {
      return;
    }

    /**
     * A picked captured version routes through the shared service; the
     * synthetic baseline (the latest snapshot or the history original) stays on
     * the modal's local path because the service models real captured versions
     * only and the baseline content is resolved by the diff presenter.
     */
    if (this.viewState.selectedBaseId !== ORIGINAL_BASE_ID) {
      await this.versionActionsService.restoreSelected(file, this.viewState.selectedBaseId);
    } else {
      const baseLines: string[] = this.diffPresenter.getBaseContent().split(this.snapshot.content.lineBreak);
      const currentLines: string[] = this.snapshot.content.getLastStateLines();

      await this.snapshotsService.applyContent(file, baseLines, {
        start: 0,
        removeCount: currentLines.length,
        newLines: baseLines,
      });
    }

    /**
     * The content changed, so the diff and its hunk indices are stale: drop the
     * navigation focus and redraw the active view against the new content.
     */
    this.viewState.activeHunkIndex = -1;
    this.diffPresenter.refreshActive();
  }

  /**
   * Deletes the selected version from the timeline, leaving the history baseline
   * and the file content untouched. Only a real captured version can be removed,
   * so this is a no-op for the synthetic baseline (the button is disabled there
   * anyway). The selection moves to the next visible version below the deleted
   * one (the older neighbour), falling back to the one above it and then to the
   * baseline when nothing is below. The change is persisted via the snapshots
   * service, and the rail and active view are re-rendered so the dropped version
   * no longer appears.
   */
  protected removeSelectedVersion(): void {
    if (this.viewState.selectedBaseId === ORIGINAL_BASE_ID) {
      return;
    }

    /**
     * Route through the shared service. The service resolves the next
     * selection against the FULL timeline (its visible list); the modal's
     * search/hide-identical filter may exclude that fallback, so the result is
     * narrowed to ids the rail still shows before applying it. The synthetic
     * baseline is the final fallback.
     */
    const result: VersionRemoveResult = this.versionActionsService.removeSelected(
      this.snapshot?.file ?? null,
      this.viewState.selectedBaseId,
    );

    if (!result.removed) {
      return;
    }

    const visibleIds: Set<string> = new Set(
      this.versionList.getVisibleVersions().map((version: FileVersion): string => version.id),
    );

    this.viewState.selectedBaseId =
      result.nextId && visibleIds.has(result.nextId) ? result.nextId : ORIGINAL_BASE_ID;
    this.viewState.activeHunkIndex = -1;
    this.versionList.render();
    this.diffPresenter.refreshActive();
  }

  /**
   * Labels the selected version in place: prompts for a tag through the shared
   * ModalsService.labelVersion entry point and, on a non-empty result, marks
   * that captured version. Unlike the editor-submenu Put label, which
   * pins the current content as a new version, this tags the slice the user is
   * looking at in the rail. A no-op for the synthetic baseline (the button is
   * disabled there anyway) and for a cancelled/blank prompt. On success the
   * rail and the active diff are re-rendered so the new label shows on the row
   * and in the side-by-side column header.
   *
   * @return {Promise<void>}
   */
  protected async labelSelectedVersion(): Promise<void> {
    if (this.viewState.selectedBaseId === ORIGINAL_BASE_ID) {
      return;
    }

    const labeled: FileVersion | null = await this.modalsService.labelVersion(
      this.snapshot?.file ?? null,
      this.viewState.selectedBaseId,
    );

    if (!labeled) {
      return;
    }

    this.versionList.render();
    this.diffPresenter.refreshActive();
  }

  /**
   * Asks for confirmation and, if granted, deletes the selected version, then
   * returns focus to the version list so further arrow/Delete keys keep working.
   * Shared by the toolbar remove button and the Delete key on the focused list,
   * so both follow the same confirm-before-delete flow. A no-op for the
   * synthetic baseline, which has no captured version to remove.
   *
   * @return {Promise<void>}
   */
  protected async confirmRemoveSelectedVersion(): Promise<void> {
    if (this.viewState.selectedBaseId === ORIGINAL_BASE_ID) {
      return;
    }

    const confirmed: boolean = await this.modalsService.confirm({
      title: this.plugin.t('modal.confirm.remove-version.title'),
      message: this.plugin.t('modal.confirm.remove-version.message'),
      confirmText: this.plugin.t('modal.confirm.remove-version.button'),
      cancelText: this.plugin.t('modal.confirm.cancel'),
    });

    if (confirmed) {
      this.removeSelectedVersion();
      this.versionsEl?.focus();
    }
  }

  /**
   * Resolves the base to select when the modal opens. With an open option
   * `initialBaseId` naming a real version the modal opens focused on that
   * version; otherwise it defaults to the latest captured version (the top
   * of the rail, showing what changed since the last save), or the Original
   * entry when the file has no snapshots yet. An unknown `initialBaseId` falls
   * back to the default so a stale id never leaves the modal pointing at
   * nothing.
   *
   * @return {string} The initial selected base id
   */
  protected getInitialBaseId(): string {
    const versions: FileVersion[] = this.snapshot.timeline.getVersions();
    const requested: string | undefined = this.options.initialBaseId;

    if (requested && versions.some((version: FileVersion): boolean => version.id === requested)) {
      return requested;
    }

    /**
     * With a selection filter active the default selection should land
     * on the first version that survives the filter, not on the unconditional
     * latest snapshot which may be filtered out. The filter list is newest-first
     * (matches getVersions()), so the first hit is also the newest match. An
     * empty matched set falls through to the baseline.
     */
    const selectionIds: ReadonlySet<string> | undefined = this.options.selectionFilterIds;

    if (selectionIds !== undefined) {
      const firstMatch: FileVersion | undefined = versions
        .find((version: FileVersion): boolean => selectionIds.has(version.id));

      if (firstMatch) {
        return firstMatch.id;
      }

      return ORIGINAL_BASE_ID;
    }

    return versions.length > 0 ? versions[0].id : ORIGINAL_BASE_ID;
  }

  /**
   * Builds the diff-view UI. The shared {@link HistoryModalShell} constructs the
   * body / main / toolbar / notice / diff-block spine and relocates the native
   * close button into the toolbar; this modal supplies the left rail and the
   * focusable diff container, then fills the toolbar and renders the rail.
   */
  protected makeUI(): void {
    const shell: HistoryModalShell = new HistoryModalShell(this.contentEl, this.modalEl);

    /**
     * The diff output is focusable (tabindex 0) so the arrow keys scroll the
     * diff while it holds focus; Delete is ignored here, since deleting a
     * snapshot only makes sense from the version list.
     */
    const regions: HistoryModalShellRegions = shell.build({
      buildColumns: (bodyEl: HTMLElement): void => this.buildRail(bodyEl),
      diffContainerAttributes: { tabindex: '0' },
      diffContainerEvents: {
        keydown: (event: Event): void => this.keyboard.handleDiffKeydown(event as KeyboardEvent),
      },
    });

    this.mainEl = regions.mainEl;
    this.toolbarEl = regions.toolbarEl;
    this.noticeEl = regions.noticeEl;
    this.columnsHeaderEl = regions.columnsHeaderEl;
    this.diffContainerEl = regions.diffContainerEl;

    this.makeToolbar();
    shell.relocateCloseButton(this.toolbarEl);

    this.renderSearch();
    this.versionList.render();
  }

  /**
   * Builds the left rail (content search above the version timeline) into the
   * shell body. With the `hideRail` open option the rail is skipped so the diff
   * and toolbar fill the modal: the panel becomes the sole navigator and there
   * are no two competing version lists side by side.
   *
   * @param {HTMLElement} bodyEl - The shell body the rail is appended to
   */
  protected buildRail(bodyEl: HTMLElement): void {
    if (this.options.hideRail === true) {
      return;
    }

    this.railEl = DomHelper.create({
      tag: 'div',
      classes: 'lct-modal-rail',
      container: bodyEl,
    });

    // Content search sits above the version timeline in the left rail.
    this.searchEl = DomHelper.create({
      tag: 'div',
      classes: 'lct-rail-search',
      container: this.railEl,
    });

    /**
     * Version timeline lives in the left rail, under the search box. It is a
     * focusable region (tabindex 0) so the arrow keys can walk the snapshots and
     * Delete can drop the selected one while the list, not the diff, has focus.
     */
    this.versionsEl = DomHelper.create({
      tag: 'div',
      classes: 'lct-versions',
      container: this.railEl,
      attributes: { tabindex: '0' },
      events: {
        keydown: (event: Event): void => this.keyboard.handleVersionsKeydown(event as KeyboardEvent),
      },
    });
  }

  /**
   * Syncs the restore/remove/label toolbar action buttons for the current base.
   * In the base-equals-current case there is nothing to restore, so the
   * restore-selected button is disabled; the remove-selected and label-selected
   * buttons are disabled whenever the synthetic baseline is selected, since only
   * a real captured version can be deleted or labelled. The presenter passes the
   * base-vs-current fact and calls this on every render so the buttons stay in
   * sync with the visible diff.
   *
   * @param {boolean} baseIsCurrent - Whether the selected base equals the current state
   */
  protected syncActionButtons(baseIsCurrent: boolean): void {
    if (this.restoreSelectedButton) {
      (this.restoreSelectedButton as HTMLButtonElement).disabled = baseIsCurrent;
      DomHelper.update(this.restoreSelectedButton, {
        classes: baseIsCurrent ? { add: 'is-disabled' } : { remove: 'is-disabled' },
      });
    }

    // Only a real captured version can be removed or labelled; the synthetic baseline has none.
    const noVersion: boolean = this.viewState.selectedBaseId === ORIGINAL_BASE_ID;

    if (this.removeSelectedButton) {
      (this.removeSelectedButton as HTMLButtonElement).disabled = noVersion;
      DomHelper.update(this.removeSelectedButton, {
        classes: noVersion ? { add: 'is-disabled' } : { remove: 'is-disabled' },
      });
    }

    if (this.labelSelectedButton) {
      (this.labelSelectedButton as HTMLButtonElement).disabled = noVersion;
      DomHelper.update(this.labelSelectedButton, {
        classes: noVersion ? { add: 'is-disabled' } : { remove: 'is-disabled' },
      });
    }
  }

  /**
   * Builds the top toolbar controls as icon buttons grouped by purpose: the
   * destructive actions (restore original, remove history) pinned to the left
   * edge, then the version controls (restore selected version, remove selected
   * version, then the hide-identical rail filter), the difference navigation,
   * and the four view-mode toggles right-aligned after them.
   * Every button is icon-only on screen but carries a text label through its
   * tooltip and aria-label so it stays usable by keyboard and screen readers. The
   * view-mode buttons keep the active-mode highlight driven by
   * updateButtonActiveStates; the destructive actions still confirm before acting.
   */
  protected makeToolbar(): void {
    const toolbarEl: HTMLElement | undefined = this.toolbarEl;

    if (!toolbarEl) {
      return;
    }

    const builder: ToolbarBuilder = new ToolbarBuilder(toolbarEl);

    /**
     * Destructive actions: each still asks for confirmation before acting. This
     * group leads the toolbar and is pushed to the left edge (its auto inline-end
     * margin in CSS) so the destructive pair reads as separate from the view
     * controls that follow on the right.
     */
    const actionsGroup: HTMLElement = builder.addGroup('lct-modal-toolbar-actions');

    builder.addButton(actionsGroup, {
      icon: 'rotate-ccw',
      label: this.plugin.t('modal.restore-original'),
      warning: true,
      onClick: async (): Promise<void> => {
        const confirmed: boolean = await this.modalsService.confirm({
          title: this.plugin.t('modal.confirm.restore.title'),
          message: this.plugin.t('modal.confirm.restore.message'),
          confirmText: this.plugin.t('modal.confirm.restore.button'),
          cancelText: this.plugin.t('modal.confirm.cancel'),
        });

        if (confirmed) {
          await this.restoreOriginalFile();
        }
      },
    });

    builder.addButton(actionsGroup, {
      icon: 'trash-2',
      label: this.plugin.t('modal.remove-history'),
      warning: true,
      onClick: async (): Promise<void> => {
        const confirmed: boolean = await this.modalsService.confirm({
          title: this.plugin.t('modal.confirm.remove.title'),
          message: this.plugin.t('modal.confirm.remove.message'),
          confirmText: this.plugin.t('modal.confirm.remove.button'),
          cancelText: this.plugin.t('modal.confirm.cancel'),
        });

        if (confirmed) {
          this.snapshotsService?.wipeOne(this.snapshot.file);
          this.close();
        }
      },
    });

    /**
     * Version controls: restore the file to the picked version (constructive,
     * the history is kept) and delete the picked version from the timeline, then
     * the rail filter that hides versions identical to the current state. The
     * filter is a toggle, so it carries the is-active accent while active.
     */
    const filterGroup: HTMLElement = builder.addGroup('lct-modal-toolbar-filter');

    this.restoreSelectedButton = builder.addButton(filterGroup, {
      icon: 'history',
      label: this.plugin.t('modal.restore-selected'),
      onClick: async (): Promise<void> => {
        const confirmed: boolean = await this.modalsService.confirm({
          title: this.plugin.t('modal.confirm.restore-version.title'),
          message: this.plugin.t('modal.confirm.restore-version.message'),
          confirmText: this.plugin.t('modal.confirm.restore-version.button'),
          cancelText: this.plugin.t('modal.confirm.cancel'),
        });

        if (confirmed) {
          await this.restoreSelectedVersion();
        }
      },
    });

    this.removeSelectedButton = builder.addButton(filterGroup, {
      icon: 'list-x',
      label: this.plugin.t('modal.remove-selected'),
      onClick: (): void => {
        void this.confirmRemoveSelectedVersion();
      },
    });

    this.labelSelectedButton = builder.addButton(filterGroup, {
      icon: 'tag',
      label: this.plugin.t('modal.label-selected'),
      onClick: async (): Promise<void> => {
        await this.labelSelectedVersion();
      },
    });

    this.hideIdenticalButton = builder.addButton(filterGroup, {
      icon: 'eye-off',
      label: this.plugin.t('modal.hide-identical'),
      onClick: (): void => {
        this.toggleHideIdentical();
      },
    });

    /**
     * Difference navigation: step between the diff hunks with wrap-around. The
     * buttons are disabled when the current diff has no hunks.
     */
    const navGroup: HTMLElement = builder.addGroup('lct-modal-toolbar-nav');

    this.viewState.navButtons.previous = builder.addButton(navGroup, {
      icon: 'chevron-up',
      label: this.plugin.t('modal.previous-difference'),
      onClick: (): void => {
        this.viewState.goToDifference(NavigationDirection.previous);
      },
    });

    this.viewState.navButtons.next = builder.addButton(navGroup, {
      icon: 'chevron-down',
      label: this.plugin.t('modal.next-difference'),
      onClick: (): void => {
        this.viewState.goToDifference(NavigationDirection.next);
      },
    });

    // View-mode toggles: the active mode is highlighted via is-active.
    const modesGroup: HTMLElement = builder.addGroup('lct-modal-toolbar-modes');

    this.viewState.modeButtons.patch = builder.addButton(modesGroup, {
      icon: 'file-text',
      label: this.plugin.t('modal.mode.patch'),
      onClick: (): void => {
        this.diffPresenter.refresh(DiffViewMode.patch);
      },
    });

    this.viewState.modeButtons.inline = builder.addButton(modesGroup, {
      icon: 'pilcrow',
      label: this.plugin.t('modal.mode.inline'),
      onClick: (): void => {
        this.diffPresenter.refresh(DiffViewMode.inline);
      },
    });

    this.viewState.modeButtons.lineByLine = builder.addButton(modesGroup, {
      icon: 'align-justify',
      label: this.plugin.t('modal.mode.line-by-line'),
      onClick: (): void => {
        this.diffPresenter.refresh(DiffOutputFormatType.line);
      },
    });

    this.viewState.modeButtons.sideBySide = builder.addButton(modesGroup, {
      icon: 'columns-2',
      label: this.plugin.t('modal.mode.side-by-side'),
      onClick: (): void => {
        this.diffPresenter.refresh(DiffOutputFormatType.side);
      },
    });

    // Set the initial active state.
    this.viewState.updateButtonActiveStates();
  }

  /**
   * Flips the hide-identical rail filter, syncs the toggle button's active
   * (is-active) accent, and re-renders the version list. Only the rail list is
   * rebuilt: the selected diff base and the diff output are untouched.
   */
  protected toggleHideIdentical(): void {
    this.viewState.hideIdenticalVersions = !this.viewState.hideIdenticalVersions;

    if (this.hideIdenticalButton) {
      DomHelper.update(this.hideIdenticalButton, {
        classes: this.viewState.hideIdenticalVersions ? { add: 'is-active' } : { remove: 'is-active' },
      });
    }

    this.versionList.render();
  }

  /**
   * Renders the content-search box above the version list. The box filters the
   * intermediate versions in the rail by their captured content. It is always
   * shown so the rail stays consistent even before any version exists; with no
   * versions a query simply matches nothing. Typing re-renders only the version
   * list (not the diff or the selection).
   */
  protected renderSearch(): void {
    if (!this.searchEl) {
      return;
    }

    DomHelper.update(this.searchEl, { classes: { remove: 'lct-rail-search-empty' } });

    new SearchComponent(this.searchEl)
      .setPlaceholder(this.plugin.t('modal.search-versions'))
      .setValue(this.viewState.searchQuery)
      .onChange((value: string): void => {
        this.viewState.searchQuery = value;
        this.versionList.render();
      });
  }

  /**
   * Selects a new diff base and refreshes the version list and active diff view.
   * No-op when the base is already selected. Shared by the rail rows and the
   * keyboard selection (both routed through the VersionList collaborator) so a
   * pick from either path coordinates the rail re-render and the diff refresh in
   * one place.
   *
   * @param {string} id - The base id to select
   */
  protected selectBase(id: string): void {
    if (this.viewState.selectedBaseId === id) {
      return;
    }

    this.viewState.selectedBaseId = id;
    this.versionList.render();
    this.diffPresenter.refreshActive();
  }

  /**
   * Builds the host adapter the owned {@link VersionList} reads its shared state
   * through. It exposes the live selection, the search/hide-identical filters,
   * and the selection-filter ids as lazy accessors (so the component always sees
   * the current values), plus the selectBase callback the component reports a
   * pick to. Keeping the modal's selection/filter fields protected and handing
   * the collaborator a narrow port preserves the encapsulation the DiffScrollSync
   * resolver established.
   *
   * @return {VersionListHost} The host port for the version-list collaborator
   */
  protected makeVersionListHost(): VersionListHost {
    return {
      snapshot: this.snapshot,
      plugin: this.plugin,
      versionsEl: (): HTMLElement | undefined => this.versionsEl,
      selectedBaseId: (): string => this.viewState.selectedBaseId,
      searchQuery: (): string => this.viewState.searchQuery,
      hideIdenticalVersions: (): boolean => this.viewState.hideIdenticalVersions,
      selectionFilterIds: (): ReadonlySet<string> | undefined => this.options.selectionFilterIds,
      selectBase: (id: string): void => this.selectBase(id),
    };
  }

  /**
   * Builds the host adapter the owned {@link GutterRevertHandler} reads its
   * shared state through. It exposes the live diff container, display mode, and
   * hunks as lazy accessors (so the handler always sees the current render),
   * hands the handler the snapshot and the services it drives the revert with,
   * and routes the post-decoration nav refresh and the post-revert redraw back
   * to the modal. Keeping the modal's diff fields protected and handing the
   * collaborator a narrow port preserves the encapsulation the VersionList host
   * established.
   *
   * @return {GutterRevertHost} The host port for the gutter-revert collaborator
   */
  protected makeGutterRevertHost(): GutterRevertHost {
    return {
      snapshot: this.snapshot,
      plugin: this.plugin,
      modalsService: this.modalsService,
      snapshotsService: this.snapshotsService,
      diffContainer: (): HTMLElement | undefined => this.diffContainerEl,
      displayMode: (): DiffRenderMode => this.viewState.currentDisplayMode,
      getHunks: (): Diff.StructuredPatchHunk[] => this.diffPresenter.getHunks(),
      updateNavButtonsState: (): void => this.viewState.updateNavButtonsState(),
      onReverted: (): void => {
        this.viewState.activeHunkIndex = -1;
        this.diffPresenter.refreshActive();
      },
    };
  }

  /**
   * Builds the host adapter the owned {@link DiffViewState} reads the live
   * render through. It exposes the live diff container and the current hunks as
   * lazy accessors so the state's hunk focus and the nav-button enablement
   * always reflect the rendered diff. Keeping the modal's diff container
   * protected and handing the collaborator a narrow port preserves the
   * encapsulation the GutterRevertHost established.
   *
   * @return {DiffViewStateHost} The host port for the diff-view-state collaborator
   */
  protected makeDiffViewStateHost(): DiffViewStateHost {
    return {
      diffContainer: (): HTMLElement | undefined => this.diffContainerEl,
      getHunks: (): Diff.StructuredPatchHunk[] => this.diffPresenter.getHunks(),
    };
  }

  /**
   * Builds the host adapter the owned {@link DiffPresenter} reads its shared
   * state and collaborators through. It hands the presenter the modal's owned
   * collaborators (view state, scroll sync, gutter reverts, diff header) as refs,
   * exposes the live diff container as a lazy accessor, resolves the
   * rail-matching base label through the version list, and takes the toolbar
   * action-button sync back so the modal keeps owning which buttons to disable.
   *
   * @return {DiffPresenterHost} The host port for the diff-presentation collaborator
   */
  protected makeDiffPresenterHost(): DiffPresenterHost {
    return {
      snapshot: this.snapshot,
      plugin: this.plugin,
      viewState: this.viewState,
      scrollSync: this.scrollSync,
      gutterReverts: this.gutterReverts,
      diffHeader: this.diffHeader,
      diffContainer: (): HTMLElementWithScrollSync | undefined => this.diffContainerEl,
      resolvePrimaryLabel: (version: FileVersion, versions: FileVersion[]): string =>
        this.versionList.resolvePrimaryLabel(version, versions),
      syncActionButtons: (baseIsCurrent: boolean): void => this.syncActionButtons(baseIsCurrent),
    };
  }

  /**
   * Builds the host adapter the owned {@link KeyboardController} reads its shared
   * state through. It hands the controller the owned version list (whose
   * selection the rail keys walk), exposes the live diff container as a lazy
   * accessor, and routes the confirm-before-delete flow back to the modal.
   *
   * @return {KeyboardControllerHost} The host port for the keyboard collaborator
   */
  protected makeKeyboardControllerHost(): KeyboardControllerHost {
    return {
      versionList: this.versionList,
      diffContainer: (): HTMLElement | undefined => this.diffContainerEl,
      confirmRemoveSelectedVersion: (): void => {
        void this.confirmRemoveSelectedVersion();
      },
    };
  }

}
