import { DiffOutputFormatType, DiffViewMode, ORIGINAL_BASE_ID } from '@/consts';
import type { DiffHeaderController } from '@/modals/diff-header-controller';
import type { DiffScrollSync } from '@/modals/diff-scroll-sync';
import type { DiffViewState } from '@/modals/diff-view-state';
import type { GutterRevertHandler } from '@/modals/gutter-revert-handler';
import { assertNever } from '@/helpers/assert-never.helper';
import * as BaseContentHelper from '@/helpers/base-content.helper';
import * as DiffRenderHelper from '@/helpers/diff-render.helper';
import * as HunkHelper from '@/helpers/hunk.helper';
import type LineChangeTrackerPlugin from '@/main';
import type { FileSnapshot } from '@/snapshots/file.snapshot';
import type { FileVersion } from '@/snapshots/file.version';
import type { DiffRenderMode, HTMLElementWithScrollSync } from '@/types';
import type * as Diff from 'diff';

/**
 * Host port the {@link DiffPresenter} reads its shared modal state and
 * collaborators through. The presenter owns the diff-render pipeline but stays
 * stateless about the modal: it reads the live diff container back through this
 * port, drives the modal's owned collaborators (view state, scroll sync, gutter
 * reverts, diff header) held here as refs, resolves the base label through the
 * version list, and reports the base-vs-current fact so the modal can sync its
 * toolbar action buttons.
 */
export interface DiffPresenterHost {
  /** The file snapshot whose content the diff renders. */
  readonly snapshot: FileSnapshot;

  /** The plugin instance, used for translation lookups. */
  readonly plugin: LineChangeTrackerPlugin;

  /** The diff-view state (selected base, display mode, hunk focus, button registries). */
  readonly viewState: DiffViewState;

  /** The side-by-side scroll-synchronisation collaborator. */
  readonly scrollSync: DiffScrollSync;

  /** The per-hunk inline revert collaborator. */
  readonly gutterReverts: GutterRevertHandler;

  /** The shared notice / columns-header controller. */
  readonly diffHeader: DiffHeaderController;

  /**
   * The rendered diff container, or `undefined` before the first render. The
   * render is a no-op DOM-wise when it is absent.
   *
   * @return {HTMLElementWithScrollSync | undefined} The diff container, or undefined
   */
  diffContainer(): HTMLElementWithScrollSync | undefined;

  /**
   * Resolves the rail-matching primary label for a picked version, used to
   * label the base (left) side of the side-by-side columns header.
   *
   * @param {FileVersion} version - The picked base version
   * @param {FileVersion[]} versions - The full version list, newest first
   * @return {string} The primary label for that version
   */
  resolvePrimaryLabel(version: FileVersion, versions: FileVersion[]): string;

  /**
   * Syncs the restore/remove/label toolbar action buttons for the current base.
   * The presenter passes whether the selected base already equals the current
   * state (nothing to restore); the modal owns which buttons to disable.
   *
   * @param {boolean} baseIsCurrent - Whether the base equals the current state
   */
  syncActionButtons(baseIsCurrent: boolean): void;
}

/**
 * Diff-presentation collaborator for the history modal.
 *
 * Extracted from {@link HistoryModal} as a plain object the modal instantiates
 * and owns (per ADR-11: deep collaborators, not DI services). It owns the diff
 * render pipeline behind {@link refresh}: resolving the base content, computing
 * the hunks, rendering the four diff modes through {@link DiffRenderHelper},
 * driving the above-diff notice and the side-by-side columns header through the
 * shared {@link DiffHeaderController}, and finalising each render (nav-button
 * state, inline revert affordances, side-by-side scroll sync). It stays
 * stateless about the modal and reads the live diff container and every owned
 * collaborator back through {@link DiffPresenterHost}, reporting the
 * base-vs-current fact so the modal keeps its toolbar action buttons in sync.
 */
export class DiffPresenter {
  /**
   * @param {DiffPresenterHost} host - The modal port the presenter reads its
   *   shared state and collaborators through.
   */
  public constructor(protected readonly host: DiffPresenterHost) {}

  /**
   * Renders the diff in the given mode: sets it active, highlights its toolbar
   * button, tears down any prior scroll sync, refreshes the notice and columns
   * header, writes the diff DOM, and runs the per-mode finalisation. This is the
   * single render entry the toolbar buttons and the modal call.
   *
   * @param {DiffRenderMode} mode - The diff mode to render
   */
  public refresh(mode: DiffRenderMode): void {
    this.host.viewState.currentDisplayMode = mode;
    this.host.viewState.updateButtonActiveStates();
    this.host.scrollSync.cleanup();
    this.updateDiffNotice();
    this.updateColumnsHeader();
    this.renderContent(mode);
    this.finalizeRender(mode);
  }

  /**
   * Re-renders whichever diff mode is currently active. Used after the diff base
   * or the file content changes so the visible output stays in sync without
   * duplicating the mode dispatch at every call site.
   */
  public refreshActive(): void {
    this.refresh(this.host.viewState.currentDisplayMode);
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
  public getBaseContent(): string {
    return BaseContentHelper.resolve(this.host.viewState.selectedBaseId, ORIGINAL_BASE_ID, {
      versions: this.host.snapshot.timeline
        .getVersions()
        .map((version: FileVersion): string => version.getContent(this.host.snapshot.content.lineBreak)),
      original: this.host.snapshot.content.getHistoryOriginalState(),
      versionContent: (id: string): string | null =>
        this.host.snapshot.timeline.getVersion(id)?.getContent(this.host.snapshot.content.lineBreak) ?? null,
    });
  }

  /**
   * Whether the current state is identical to the selected diff base. Used to
   * render the "no changes" placeholder when the picked base matches the live
   * content.
   *
   * @return {boolean} True when base and current content are equal
   */
  public isBaseSameCurrent(): boolean {
    return this.getBaseContent() === this.host.snapshot.content.getLastState();
  }

  /**
   * Computes the line-level hunks between the selected base and the current
   * state. These back the inline per-hunk revert affordances and the
   * next/previous navigation, and are recomputed on demand so the offsets always
   * reflect the live content.
   *
   * @return {Diff.StructuredPatchHunk[]} The hunks, ordered top to bottom
   */
  public getHunks(): Diff.StructuredPatchHunk[] {
    return HunkHelper.diff(
      this.getBaseContent().split(this.host.snapshot.content.lineBreak),
      this.host.snapshot.content.getLastStateLines(),
      this.host.snapshot.content.lineBreak,
    );
  }

  /**
   * Writes the diff DOM for the given mode into the live container. A no-op
   * before the container exists; the surrounding state updates still run so the
   * notice, columns header, and button state stay consistent.
   *
   * @param {DiffRenderMode} mode - The diff mode to render
   */
  protected renderContent(mode: DiffRenderMode): void {
    const container: HTMLElementWithScrollSync | undefined = this.host.diffContainer();

    if (!container) {
      return;
    }

    DiffRenderHelper.render({
      baseLines: this.getBaseContent().split(this.host.snapshot.content.lineBreak),
      currentLines: this.host.snapshot.content.getLastStateLines(),
      lineBreak: this.host.snapshot.content.lineBreak,
      mode,
      container,
      filePath: this.host.snapshot?.file?.path ?? '',
      plugin: this.host.plugin,
    });
  }

  /**
   * Runs the mode-specific tail after the diff DOM is written. Patch mode has no
   * per-row structure, so it only refreshes the (disabled) nav buttons; the
   * inline and diff2html modes place the per-hunk revert affordances (which also
   * refresh the nav buttons), and side-by-side additionally schedules the
   * two-column scroll sync.
   *
   * @param {DiffRenderMode} mode - The mode that was just rendered
   */
  protected finalizeRender(mode: DiffRenderMode): void {
    switch (mode) {
      case DiffViewMode.patch:
        this.host.viewState.updateNavButtonsState();

        return;
      case DiffViewMode.inline:
        this.host.gutterReverts.attachInlineReverts();

        return;
      case DiffOutputFormatType.line:
        this.host.gutterReverts.attachInlineReverts();

        return;
      case DiffOutputFormatType.side:
        this.host.gutterReverts.attachInlineReverts();
        this.host.scrollSync.schedule();

        return;
      default:
        assertNever(mode, 'diff display mode');
    }
  }

  /**
   * Shows or hides the above-diff notice and syncs the toolbar action buttons,
   * both driven by whether the selected base resolves to the current content.
   * The notice is revealed, with the same text the empty-diff placeholder uses,
   * whenever the base equals current; otherwise it is hidden. The modal owns the
   * matching button-disable policy, driven by the base-vs-current fact this
   * passes it.
   */
  protected updateDiffNotice(): void {
    const identical: boolean = this.isBaseSameCurrent();

    this.host.syncActionButtons(identical);
    this.host.diffHeader.updateNotice(identical ? this.getEmptyDiffText() : null);
  }

  /**
   * Shows or hides the side-by-side column header and, when shown, labels the
   * left column with the picked base and the right column with the current
   * state. It is shown for the two-column side-by-side mode (including the
   * identical-content case, so the header does not vanish when the diff is
   * empty) and hidden in the single-column modes.
   */
  protected updateColumnsHeader(): void {
    const visible: boolean = this.host.viewState.currentDisplayMode === DiffOutputFormatType.side;

    this.host.diffHeader.updateColumnsHeader(visible ? this.getBaseLabel() : null);
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
    if (this.host.viewState.selectedBaseId !== ORIGINAL_BASE_ID) {
      const versions: FileVersion[] = this.host.snapshot.timeline.getVersions();
      const version: FileVersion | null = this.host.snapshot.timeline.getVersion(this.host.viewState.selectedBaseId);

      if (version) {
        return this.host.resolvePrimaryLabel(version, versions);
      }
    }

    return this.host.plugin.t('modal.version.original');
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
    return this.host.viewState.selectedBaseId === ORIGINAL_BASE_ID
      ? this.host.plugin.t('modal.no-changes')
      : this.host.plugin.t('modal.identical-to-current');
  }
}
