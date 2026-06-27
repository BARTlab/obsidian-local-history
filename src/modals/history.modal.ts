import { DIFF_SCROLL_STEP_PX, DiffOutputFormatType, DiffViewMode, ListSelectionDirection, NavigationDirection, ORIGINAL_BASE_ID, VersionListEdge } from '@/consts';
import { Inject } from '@/decorators/inject.decorator';
import { DiffScrollSync } from '@/modals/diff-scroll-sync';
import { DiffViewState, type DiffViewStateHost } from '@/modals/diff-view-state';
import { GutterRevertHandler, type GutterRevertHost } from '@/modals/gutter-revert-handler';
import { VersionList, type VersionListHost } from '@/modals/version-list.component';
import { assertNever } from '@/helpers/assert-never.helper';
import { BaseContentHelper } from '@/helpers/base-content.helper';
import { DiffRenderHelper } from '@/helpers/diff-render.helper';
import { DomHelper } from '@/helpers/dom.helper';
import { HunkHelper } from '@/helpers/hunk.helper';
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
  ToolbarButtonConfig,
  VersionRemoveResult
} from '@/types';
import type * as Diff from 'diff';
import { type App, Modal, Notice, SearchComponent, setIcon, type TFile } from 'obsidian';

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
    protected plugin: LineChangeTrackerPlugin,
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

    this.renderDiff();
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
      const originalContent: string = this.snapshot.getHistoryOriginalState();
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

    if (!file || this.isBaseSameCurrent()) {
      return;
    }

    /**
     * A picked captured version routes through the shared service; the
     * synthetic baseline (the latest snapshot or the history original) stays on
     * the modal's local path because the service models real captured versions
     * only and the baseline content is resolved by the modal's BaseContentHelper.
     */
    if (this.viewState.selectedBaseId !== ORIGINAL_BASE_ID) {
      await this.versionActionsService.restoreSelected(file, this.viewState.selectedBaseId);
    } else {
      const baseLines: string[] = this.getBaseContent().split(this.snapshot.lineBreak);
      const currentLines: string[] = this.snapshot.getLastStateLines();

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
    this.refreshActiveView();
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

    const nextId: string =
      result.nextId && visibleIds.has(result.nextId) ? result.nextId : ORIGINAL_BASE_ID;

    this.viewState.selectedBaseId = nextId;
    this.viewState.activeHunkIndex = -1;
    this.versionList.render();
    this.refreshActiveView();
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
    this.refreshActiveView();
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
   * Handles a key press while the version list holds focus. The up/down arrows
   * move the selection between snapshots (clamping at the ends), Home/End jump to
   * the first/last snapshot, and Delete (or Backspace, the primary delete key on
   * macOS) drops the selected snapshot through the same confirm flow as the
   * toolbar button. Other keys are left alone so default behaviour (Tab, typing
   * into the search box, the modal's own Escape) is untouched.
   *
   * @param {KeyboardEvent} event - The key event from the version list
   */
  protected handleVersionsKeydown(event: KeyboardEvent): void {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.versionList.moveSelection(ListSelectionDirection.down);

        return;
      case 'ArrowUp':
        event.preventDefault();
        this.versionList.moveSelection(ListSelectionDirection.up);

        return;
      case 'Home':
        event.preventDefault();
        this.versionList.moveSelectionToEdge(VersionListEdge.first);

        return;
      case 'End':
        event.preventDefault();
        this.versionList.moveSelectionToEdge(VersionListEdge.last);

        return;
      case 'Delete':
      case 'Backspace':
        event.preventDefault();
        void this.confirmRemoveSelectedVersion();

        return;
      default:
        return;
    }
  }

  /**
   * Handles a key press while the diff pane holds focus, scrolling the active
   * diff scroller: the up/down arrows nudge it a step, PageUp/PageDown move it
   * by almost a full pane (a small overlap is kept for context), and Home/End
   * jump to the top/bottom. So the same keys that walk the snapshots in the list
   * instead move through the diff content here. The browser clamps scrollTop, so
   * an over-scroll at either end is a safe no-op. Delete is intentionally
   * ignored: removing a snapshot only makes sense from the list.
   *
   * @param {KeyboardEvent} event - The key event from the diff pane
   */
  protected handleDiffKeydown(event: KeyboardEvent): void {
    const scroller: HTMLElement | null = this.getDiffScroller();

    if (!scroller) {
      return;
    }

    /**
     * A page keeps a small overlap so the line the user was reading stays on
     * screen, with a floor so a very short pane still advances.
     */
    const page: number = Math.max(DIFF_SCROLL_STEP_PX, scroller.clientHeight - DIFF_SCROLL_STEP_PX);

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        scroller.scrollTop += DIFF_SCROLL_STEP_PX;

        return;
      case 'ArrowUp':
        event.preventDefault();
        scroller.scrollTop -= DIFF_SCROLL_STEP_PX;

        return;
      case 'PageDown':
        event.preventDefault();
        scroller.scrollTop += page;

        return;
      case 'PageUp':
        event.preventDefault();
        scroller.scrollTop -= page;

        return;
      case 'Home':
        event.preventDefault();
        scroller.scrollTop = 0;

        return;
      case 'End':
        event.preventDefault();
        scroller.scrollTop = scroller.scrollHeight;

        return;
      default:
        return;
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
    const versions: FileVersion[] = this.snapshot.getVersions();
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
   * Resolves the scrollable element of the diff pane for the active view mode:
   * the patch container, the inline container, the line-by-line wrapper, or the
   * first side-by-side column wrapper (its scroll is mirrored to the other
   * column by the scroll-sync). Returns null before any diff is rendered.
   *
   * @return {HTMLElement | null} The diff scroll container, or null
   */
  protected getDiffScroller(): HTMLElement | null {
    return this.diffContainerEl?.querySelector<HTMLElement>(
      '.lct-patch-container, .lct-inline-container, .d2h-wrapper.d2h-line, .d2h-side-column-wrapper',
    ) ?? null;
  }

  /**
   * Creates the UI elements for the diff view.
   *
   * With the `hideRail` open option the left rail (search + version list) is
   * not rendered and the diff/toolbar fill the modal. The panel uses this
   * mode so it stays the sole navigator and there are no two competing version
   * lists side by side. Without the option the rail is built as before.
   */
  protected makeUI(): void {
    /**
     * Obsidian Settings-style shell: the body splits into a left navigation
     * column (the version rail) and a right content column. The content column
     * stacks the toolbar above the diff, so the rail runs full height on the
     * left and the toolbar plus diff fill the right.
     */
    const bodyEl: HTMLElement = DomHelper.create({
      tag: 'div',
      classes: 'lct-modal-body',
      container: this.contentEl,
    });

    const hideRail: boolean = this.options.hideRail === true;

    if (!hideRail) {
      this.railEl = DomHelper.create({
        tag: 'div',
        classes: 'lct-modal-rail',
        container: bodyEl,
      });
    }

    this.mainEl = DomHelper.create({
      tag: 'div',
      classes: 'lct-modal-main',
      container: bodyEl,
    });

    // The toolbar lives at the top of the right content column, above the diff.
    this.toolbarEl = DomHelper.create({
      tag: 'div',
      classes: 'lct-modal-toolbar',
      container: this.mainEl,
    });

    this.makeToolbar();

    /**
     * Pull the modal's native close button out of its floating top-right corner
     * and append it as the last control in the toolbar, so it lines up with the
     * other icon buttons instead of hovering apart. It drops the raised round
     * look and wears the plain .clickable-icon look the rest of the row uses;
     * the static position is restored in CSS.
     */
    const closeButtonEl: HTMLElement | null = this.modalEl.querySelector<HTMLElement>('.modal-close-button');

    if (closeButtonEl) {
      closeButtonEl.classList.remove('mod-raised');
      closeButtonEl.classList.add('clickable-icon');
      this.toolbarEl.appendChild(closeButtonEl);
    }

    /**
     * The rail (search + version list) is built only when not hidden. In
     * rail-less mode the panel is the navigator and the modal acts as a pure
     * viewer focused on the chosen version.
     */
    if (this.railEl) {
      // Content search sits above the version timeline in the left rail.
      this.searchEl = DomHelper.create({
        tag: 'div',
        classes: 'lct-rail-search',
        container: this.railEl,
      });

      /**
       * Version timeline lives in the left rail, under the search box. It is a
       * focusable region (tabindex 0) so the arrow keys can walk the snapshots
       * and Delete can drop the selected one while the list, not the diff, has
       * focus.
       */
      this.versionsEl = DomHelper.create({
        tag: 'div',
        classes: 'lct-versions',
        container: this.railEl,
        attributes: { tabindex: '0' },
        events: {
          keydown: (event: Event): void => this.handleVersionsKeydown(event as KeyboardEvent),
        },
      });
    }

    /**
     * Notice above the diff, hidden until the selected base equals the current
     * state. It gives a single, mode-independent message so a blank diff is
     * never left unexplained.
     */
    this.noticeEl = DomHelper.create({
      tag: 'div',
      classes: ['lct-diff-notice', 'lct-diff-notice-hidden'],
      container: this.mainEl,
    });

    /**
     * The diff block bundles the side-by-side column header and the diff output
     * in one bordered box, so the header reads as part of the diff: it sits as a
     * fixed row at the top of the block and the diff fills the rest below it.
     */
    const blockEl: HTMLElement = DomHelper.create({
      tag: 'div',
      classes: 'lct-diff-block',
      container: this.mainEl,
    });

    /**
     * Column header for the side-by-side mode, hidden in the single-column
     * modes. It names the version each column shows (picked base vs current).
     */
    this.columnsHeaderEl = DomHelper.create({
      tag: 'div',
      classes: ['lct-diff-columns', 'lct-diff-columns-hidden'],
      container: blockEl,
    });

    /**
     * The diff output fills the rest of the block. Per-hunk revert lives inline
     * inside the diff rows, not in a separate panel. It is focusable (tabindex 0)
     * so the arrow keys scroll the diff while it holds focus; Delete is ignored
     * here, since deleting a snapshot only makes sense from the version list.
     */
    this.diffContainerEl = DomHelper.create({
      tag: 'div',
      classes: 'diff-container',
      container: blockEl,
      attributes: { tabindex: '0' },
      events: {
        keydown: (event: Event): void => this.handleDiffKeydown(event as KeyboardEvent),
      },
    });

    this.renderSearch();
    this.versionList.render();
  }

  /**
   * Shows or hides the above-diff notice and syncs the restore-selected button's
   * enabled state, both driven by whether the selected base resolves to the
   * current content. The notice is revealed, with the same text the empty-diff
   * placeholder uses, whenever the base equals current (the original-vs-current
   * "no changes" case or a picked version identical to current); otherwise it is
   * hidden. In that same identical case there is nothing to restore, so the
   * restore-selected button is disabled. The remove-selected button is disabled
   * whenever the synthetic baseline is selected, since only a real captured
   * version can be deleted. Called by every render path so all stay in sync with
   * the visible diff.
   */
  protected updateDiffNotice(): void {
    const identical: boolean = this.isBaseSameCurrent();

    if (this.restoreSelectedButton) {
      (this.restoreSelectedButton as HTMLButtonElement).disabled = identical;
      DomHelper.update(this.restoreSelectedButton, {
        classes: identical ? { add: 'is-disabled' } : { remove: 'is-disabled' },
      });
    }

    if (this.removeSelectedButton) {
      const noVersion: boolean = this.viewState.selectedBaseId === ORIGINAL_BASE_ID;

      (this.removeSelectedButton as HTMLButtonElement).disabled = noVersion;
      DomHelper.update(this.removeSelectedButton, {
        classes: noVersion ? { add: 'is-disabled' } : { remove: 'is-disabled' },
      });
    }

    if (this.labelSelectedButton) {
      /**
       * Only a real captured version can carry a label; the synthetic baseline
       * has no version to tag, so the action is disabled there.
       */
      const noVersion: boolean = this.viewState.selectedBaseId === ORIGINAL_BASE_ID;

      (this.labelSelectedButton as HTMLButtonElement).disabled = noVersion;
      DomHelper.update(this.labelSelectedButton, {
        classes: noVersion ? { add: 'is-disabled' } : { remove: 'is-disabled' },
      });
    }

    if (!this.noticeEl) {
      return;
    }

    DomHelper.update(this.noticeEl, {
      text: identical ? this.getEmptyDiffText() : undefined,
      classes: identical ? { remove: 'lct-diff-notice-hidden' } : { add: 'lct-diff-notice-hidden' },
    });
  }

  /**
   * Resolves the label for the diff's base (left) side, matching the version
   * names used in the rail. A picked version shows its custom label or, when
   * unlabeled, its derived action (created/modified/cleared); the Original
   * entry (the only base when no snapshots exist) shows "Original".
   *
   * @return {string} The base-side label
   */
  protected getBaseLabel(): string {
    if (this.viewState.selectedBaseId !== ORIGINAL_BASE_ID) {
      const versions: FileVersion[] = this.snapshot.getVersions();
      const version: FileVersion | null = this.snapshot.getVersion(this.viewState.selectedBaseId);

      if (version) {
        return this.versionList.resolvePrimaryLabel(version, versions);
      }
    }

    return this.plugin.t('modal.version.original');
  }

  /**
   * Shows or hides the side-by-side column header and, when shown, labels the
   * left column with the picked base and the right column with the current
   * state. It is shown for the two-column side-by-side mode (including the
   * identical-content case, so the header does not vanish when the diff is
   * empty) and hidden in the single-column modes.
   */
  protected updateColumnsHeader(): void {
    if (!this.columnsHeaderEl) {
      return;
    }

    const visible: boolean = this.viewState.currentDisplayMode === DiffOutputFormatType.side;

    if (!visible) {
      DomHelper.update(this.columnsHeaderEl, { classes: { add: 'lct-diff-columns-hidden' } });

      return;
    }

    DomHelper.update(this.columnsHeaderEl, {
      classes: { remove: 'lct-diff-columns-hidden' },
      children: [
        { tag: 'div', classes: 'lct-diff-column-title', text: this.getBaseLabel() },
        { tag: 'div', classes: 'lct-diff-column-title', text: this.plugin.t('modal.version.current') },
      ],
    });
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
    /**
     * Destructive actions: each still asks for confirmation before acting. This
     * group leads the toolbar and is pushed to the left edge (its auto inline-end
     * margin in CSS) so the destructive pair reads as separate from the view
     * controls that follow on the right.
     */
    const actionsGroup: HTMLElement = this.makeToolbarGroup('lct-modal-toolbar-actions');

    this.makeToolbarButton(actionsGroup, {
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

    this.makeToolbarButton(actionsGroup, {
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
    const filterGroup: HTMLElement = this.makeToolbarGroup('lct-modal-toolbar-filter');

    this.restoreSelectedButton = this.makeToolbarButton(filterGroup, {
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

    this.removeSelectedButton = this.makeToolbarButton(filterGroup, {
      icon: 'list-x',
      label: this.plugin.t('modal.remove-selected'),
      onClick: (): void => {
        void this.confirmRemoveSelectedVersion();
      },
    });

    this.labelSelectedButton = this.makeToolbarButton(filterGroup, {
      icon: 'tag',
      label: this.plugin.t('modal.label-selected'),
      onClick: async (): Promise<void> => {
        await this.labelSelectedVersion();
      },
    });

    this.hideIdenticalButton = this.makeToolbarButton(filterGroup, {
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
    const navGroup: HTMLElement = this.makeToolbarGroup('lct-modal-toolbar-nav');

    this.viewState.navButtons.previous = this.makeToolbarButton(navGroup, {
      icon: 'chevron-up',
      label: this.plugin.t('modal.previous-difference'),
      onClick: (): void => {
        this.viewState.goToDifference(NavigationDirection.previous);
      },
    });

    this.viewState.navButtons.next = this.makeToolbarButton(navGroup, {
      icon: 'chevron-down',
      label: this.plugin.t('modal.next-difference'),
      onClick: (): void => {
        this.viewState.goToDifference(NavigationDirection.next);
      },
    });

    // View-mode toggles: the active mode is highlighted via is-active.
    const modesGroup: HTMLElement = this.makeToolbarGroup('lct-modal-toolbar-modes');

    this.viewState.modeButtons.patch = this.makeToolbarButton(modesGroup, {
      icon: 'file-text',
      label: this.plugin.t('modal.mode.patch'),
      onClick: (): void => {
        this.showCleanPatch();
      },
    });

    this.viewState.modeButtons.inline = this.makeToolbarButton(modesGroup, {
      icon: 'pilcrow',
      label: this.plugin.t('modal.mode.inline'),
      onClick: (): void => {
        this.renderInlineDiff();
      },
    });

    this.viewState.modeButtons.lineByLine = this.makeToolbarButton(modesGroup, {
      icon: 'align-justify',
      label: this.plugin.t('modal.mode.line-by-line'),
      onClick: (): void => {
        this.renderDiff(DiffOutputFormatType.line);
      },
    });

    this.viewState.modeButtons.sideBySide = this.makeToolbarButton(modesGroup, {
      icon: 'columns-2',
      label: this.plugin.t('modal.mode.side-by-side'),
      onClick: (): void => {
        this.renderDiff(DiffOutputFormatType.side);
      },
    });

    // Set the initial active state.
    this.viewState.updateButtonActiveStates();
  }

  /**
   * Creates one toolbar group: a flat row of icon buttons. The modifier class
   * controls the group's placement (the destructive actions are pinned to the
   * left edge, the rest are right-aligned) and is the only per-group styling
   * hook now that the toolbar is built from plain elements rather than Setting
   * rows.
   *
   * @param {string} modifier - The group's modifier class
   * @return {HTMLElement} The created group container
   */
  protected makeToolbarGroup(modifier: string): HTMLElement {
    return DomHelper.create({
      tag: 'div',
      classes: ['lct-modal-toolbar-group', modifier],
      container: this.toolbarEl,
    });
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
   * Builds one accessible icon button inside a toolbar group, the same way the
   * inline revert affordance is built: a native button carrying Obsidian's
   * .clickable-icon look (hover background, size, and radius come from the
   * theme), an aria-label that doubles as the hover tooltip, and a click
   * handler. It shows only the icon but is never a label-less control for
   * keyboard or screen-reader users. The warning option adds the destructive
   * accent (.lct-toolbar-warning) for the restore-original and remove-history
   * actions; the built-in mod-warning is avoided because on a button it paints a
   * solid error fill that hides the icon.
   *
   * @param {HTMLElement} group - The toolbar group to append the button to
   * @param {ToolbarButtonConfig} config - The button's icon, label, handler, and flags
   * @return {HTMLButtonElement} The created button
   */
  protected makeToolbarButton(group: HTMLElement, config: ToolbarButtonConfig): HTMLButtonElement {
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
    this.refreshActiveView();
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
      getHunks: (): Diff.StructuredPatchHunk[] => this.getHunks(),
      updateNavButtonsState: (): void => this.viewState.updateNavButtonsState(),
      onReverted: (): void => {
        this.viewState.activeHunkIndex = -1;
        this.refreshActiveView();
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
      getHunks: (): Diff.StructuredPatchHunk[] => this.getHunks(),
    };
  }

  /**
   * Re-renders whichever diff view is currently active. Used after the diff
   * base or the file content changes so the visible output stays in sync with
   * the selected mode without duplicating the mode dispatch at every call site.
   */
  protected refreshActiveView(): void {
    switch (this.viewState.currentDisplayMode) {
      case DiffViewMode.patch:
        this.showCleanPatch();

        return;
      case DiffViewMode.inline:
        this.renderInlineDiff();

        return;
      case DiffOutputFormatType.line:
        this.renderDiff(DiffOutputFormatType.line);

        return;
      case DiffOutputFormatType.side:
        this.renderDiff(DiffOutputFormatType.side);

        return;
      default:
        assertNever(this.viewState.currentDisplayMode, 'diff display mode');
    }
  }

  /**
   * Resolves the content of the currently selected diff base. A picked
   * intermediate version resolves to that version's captured content. The
   * synthetic baseline entry (or a stale id whose version no longer exists)
   * resolves to the LATEST captured snapshot, falling back to the original only
   * when no snapshot exists. The branch logic lives in the pure
   * BaseContentHelper so it can be unit-tested without the modal DOM.
   *
   * @return {string} The base content to diff the current state against
   */
  protected getBaseContent(): string {
    return BaseContentHelper.resolve(this.viewState.selectedBaseId, ORIGINAL_BASE_ID, {
      versions: this.snapshot
        .getVersions()
        .map((version: FileVersion): string => version.getContent(this.snapshot.lineBreak)),
      original: this.snapshot.getHistoryOriginalState(),
      versionContent: (id: string): string | null =>
        this.snapshot.getVersion(id)?.getContent(this.snapshot.lineBreak) ?? null,
    });
  }

  /**
   * Whether the current state is identical to the selected diff base.
   * Used to render the "no changes" placeholder when the picked base matches
   * the live content.
   *
   * @return {boolean} True when base and current content are equal
   */
  protected isBaseSameCurrent(): boolean {
    return this.getBaseContent() === this.snapshot.getLastState();
  }

  /**
   * Picks the placeholder text shown when the selected base equals the current
   * state. A picked intermediate version that matches the live content reads
   * "Identical to current" so the user understands the chosen base holds the
   * same text, distinguishing it from the original-vs-current "No changes" case
   * where the file simply was never modified.
   *
   * @return {string} The empty-diff placeholder text for the current base
   */
  protected getEmptyDiffText(): string {
    return this.viewState.selectedBaseId === ORIGINAL_BASE_ID
      ? this.plugin.t('modal.no-changes')
      : this.plugin.t('modal.identical-to-current');
  }

  /**
   * Computes the line-level hunks between the selected base and the current
   * state. These back the inline per-hunk revert affordances and the
   * next/previous navigation, and are recomputed on demand so the offsets always
   * reflect the live content.
   *
   * @return {Diff.StructuredPatchHunk[]} The hunks, ordered top to bottom
   */
  protected getHunks(): Diff.StructuredPatchHunk[] {
    return HunkHelper.diff(
      this.getBaseContent().split(this.snapshot.lineBreak),
      this.snapshot.getLastStateLines(),
      this.snapshot.lineBreak,
    );
  }

  /**
   * Shows the clean patch in a readable format.
   * Delegates the DOM rendering to {@link DiffRenderHelper}; the per-row revert
   * affordances are skipped here because patch mode has no per-row structure to
   * anchor them to, and the navigation buttons are refreshed at the end.
   */
  protected showCleanPatch(): void {
    this.viewState.currentDisplayMode = DiffViewMode.patch;
    this.viewState.updateButtonActiveStates();
    this.scrollSync.cleanup();
    this.updateDiffNotice();
    this.updateColumnsHeader();

    if (this.diffContainerEl) {
      DiffRenderHelper.render({
        baseLines: this.getBaseContent().split(this.snapshot.lineBreak),
        currentLines: this.snapshot.getLastStateLines(),
        lineBreak: this.snapshot.lineBreak,
        mode: DiffViewMode.patch,
        container: this.diffContainerEl,
        filePath: this.snapshot?.file?.path ?? '',
        plugin: this.plugin,
      });
    }

    /**
     * Patch mode has no per-row structure for inline revert and disables the
     * navigation buttons (no anchors to step through).
     */
    this.viewState.updateNavButtonsState();
  }

  /**
   * Renders an inline diff between the selected base and the current state,
   * highlighting changed words inside modified lines instead of marking the
   * whole line. Delegates the DOM rendering to {@link DiffRenderHelper}; the
   * per-hunk revert affordances and the nav button refresh stay here because
   * they are file-mode specific (they need a snapshot to write back to).
   */
  protected renderInlineDiff(): void {
    this.viewState.currentDisplayMode = DiffViewMode.inline;
    this.viewState.updateButtonActiveStates();
    this.scrollSync.cleanup();
    this.updateDiffNotice();
    this.updateColumnsHeader();

    if (this.diffContainerEl) {
      DiffRenderHelper.render({
        baseLines: this.getBaseContent().split(this.snapshot.lineBreak),
        currentLines: this.snapshot.getLastStateLines(),
        lineBreak: this.snapshot.lineBreak,
        mode: DiffViewMode.inline,
        container: this.diffContainerEl,
        filePath: this.snapshot?.file?.path ?? '',
        plugin: this.plugin,
      });
    }

    /**
     * Map the rendered inline rows back to hunks and place the per-hunk revert
     * affordances; this also refreshes the navigation button state.
     */
    this.gutterReverts.attachInlineReverts();
  }

  /**
   * Renders the diff view in the specified diff2html format (line-by-line or
   * side-by-side). Delegates the DOM rendering to {@link DiffRenderHelper}; the
   * per-hunk revert affordances and the side-by-side scroll sync stay here
   * because they are file-mode specific.
   *
   * @param {DiffOutputFormatType} format - The format of the diff view (defaults to 'side-by-side')
   */
  protected renderDiff(format: DiffOutputFormatType = DiffOutputFormatType.side): void {
    this.viewState.currentDisplayMode = format;
    this.viewState.updateButtonActiveStates();
    this.scrollSync.cleanup();
    this.updateDiffNotice();
    this.updateColumnsHeader();

    if (this.diffContainerEl) {
      DiffRenderHelper.render({
        baseLines: this.getBaseContent().split(this.snapshot.lineBreak),
        currentLines: this.snapshot.getLastStateLines(),
        lineBreak: this.snapshot.lineBreak,
        mode: format,
        container: this.diffContainerEl,
        filePath: this.snapshot?.file?.path ?? '',
        plugin: this.plugin,
      });
    }

    /**
     * Map the rendered diff2html rows back to hunks and place the per-hunk
     * revert affordances; this also refreshes the navigation button state.
     */
    this.gutterReverts.attachInlineReverts();

    /**
     * Side-by-side mode mirrors scroll between its two columns; the owned
     * collaborator defers the listener setup until the diff2html DOM mounts and
     * bails if the container is swapped before the timer fires.
     */
    if (format === DiffOutputFormatType.side) {
      this.scrollSync.schedule();
    }
  }
}
