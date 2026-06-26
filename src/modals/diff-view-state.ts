import { DiffOutputFormatType, DiffViewMode, ORIGINAL_BASE_ID } from '@/consts';
import type { NavigationDirection } from '@/consts';
import { DomHelper } from '@/helpers/dom.helper';
import { NavigationHelper } from '@/helpers/navigation.helper';
import type { DiffRenderMode } from '@/types';
import type * as Diff from 'diff';

/**
 * Host port the {@link DiffViewState} reads the live render through. The state
 * collaborator owns the diff-view selection, mode, hunk focus, and the toolbar
 * mode/nav button registries, but stays stateless about the modal's DOM: it
 * reads the rendered diff container and the current hunks back through this port
 * so the hunk focus and the nav-button enablement always reflect the live diff.
 */
export interface DiffViewStateHost {
  /**
   * The rendered diff container, or `undefined` before the first render. The
   * hunk focus is a no-op when it is absent.
   *
   * @return {HTMLElement | undefined} The diff container, or undefined
   */
  diffContainer(): HTMLElement | undefined;

  /**
   * The line-level hunks between the selected base and the live state, in
   * document order. Recomputed on demand so the nav-button enablement and the
   * wrap-around walk reflect the live content.
   *
   * @return {Diff.StructuredPatchHunk[]} The hunks, top to bottom
   */
  getHunks(): Diff.StructuredPatchHunk[];
}

/**
 * References to the four view-mode toggle buttons, kept so the active-mode
 * highlight can be flipped when the display mode changes.
 */
export interface ModeButtonRefs {
  /**
   * Button for patch mode.
   */
  patch?: HTMLElement;
  /**
   * Button for inline word-diff mode.
   */
  inline?: HTMLElement;
  /**
   * Button for line-by-line mode.
   */
  lineByLine?: HTMLElement;
  /**
   * Button for side-by-side mode.
   */
  sideBySide?: HTMLElement;
}

/**
 * References to the next/previous difference navigation buttons, kept so they
 * can be disabled when the current diff has no hunks to walk.
 */
export interface NavButtonRefs {
  /**
   * Button that jumps to the previous difference.
   */
  previous?: HTMLElement;
  /**
   * Button that jumps to the next difference.
   */
  next?: HTMLElement;
}

/**
 * Diff-view-state collaborator for the history modal.
 *
 * Extracted from {@link HistoryModal} as a plain object the modal instantiates
 * and owns (per ADR-11: deep collaborators, not DI services). It owns
 * the modal's diff-view state - the selected base, the active display mode, the
 * focused hunk index, the hide-identical rail filter, and the content-search
 * query - together with the toolbar mode/nav button registries and the three
 * behaviours that act on that state: flipping the active-mode highlight,
 * stepping the next/previous difference focus (with wrap-around), and syncing
 * the nav-button enablement. The modal holds a reference and reads/mutates the
 * state through it, while the live diff container and hunks are read back
 * through {@link DiffViewStateHost} so the focus and button state always match
 * the rendered diff.
 */
export class DiffViewState {
  /**
   * Id of the currently selected diff base. Set on open to the latest captured
   * version (so the modal opens on "what changed since the last save"), or to
   * the Original entry when the file has no snapshots yet. May be changed to any
   * other version's id to diff the current state against that earlier point.
   */
  public selectedBaseId: string = ORIGINAL_BASE_ID;

  /**
   * Current content-search query for the version rail. An empty string shows
   * every version; a non-empty query keeps only versions whose captured content
   * contains it (case-insensitive). It never affects the selected diff base.
   */
  public searchQuery: string = '';

  /**
   * Whether the rail hides intermediate versions whose captured content is
   * identical to the current state. Off by default so the full timeline shows;
   * toggled from the toolbar. It is a view-only filter over the rail list and
   * never changes the selected diff base.
   */
  public hideIdenticalVersions: boolean = false;

  /**
   * The current display mode for the diff view. One of the four
   * {@link DiffRenderMode} values (patch, inline, line-by-line, side-by-side).
   * Defaults to side-by-side.
   */
  public currentDisplayMode: DiffRenderMode = DiffOutputFormatType.side;

  /**
   * Index of the difference currently focused by the next/previous navigation,
   * or -1 when none is focused yet. It indexes into the hunks computed for the
   * selected base, and is reset whenever the diff changes (base switch, revert,
   * or content change) so a stale index can never highlight the wrong block.
   */
  public activeHunkIndex: number = -1;

  /**
   * References to the mode toggle buttons.
   * Used to update the active state when switching between diff modes.
   */
  public readonly modeButtons: ModeButtonRefs = {};

  /**
   * References to the next/previous difference navigation buttons, kept so they
   * can be disabled when the current diff has no hunks to walk.
   */
  public readonly navButtons: NavButtonRefs = {};

  /**
   * @param {DiffViewStateHost} host - The modal port the state reads the live
   *   diff container and hunks back through.
   */
  public constructor(protected readonly host: DiffViewStateHost) {}

  /**
   * Gets the currently active button based on the current display mode.
   * Returns the button element that corresponds to the active diff view mode.
   *
   * @return {HTMLElement | undefined} The active button element, or undefined if no mode is active
   */
  public getActiveButton(): HTMLElement | undefined {
    const buttonByMode: Record<DiffRenderMode, HTMLElement | undefined> = {
      [DiffViewMode.patch]: this.modeButtons.patch,
      [DiffViewMode.inline]: this.modeButtons.inline,
      [DiffOutputFormatType.line]: this.modeButtons.lineByLine,
      [DiffOutputFormatType.side]: this.modeButtons.sideBySide,
    };

    return buttonByMode[this.currentDisplayMode];
  }

  /**
   * Updates the active state of mode buttons based on the current display mode.
   */
  public updateButtonActiveStates(): void {
    Object.values(this.modeButtons).forEach((button: HTMLElement): void => {
      DomHelper.update(
        button,
        { classes: { remove: 'is-active' } }
      );
    });

    const activeButton: HTMLElement | undefined = this.getActiveButton();

    if (!activeButton) {
      return;
    }

    DomHelper.update(
      activeButton,
      { classes: { add: 'is-active' } }
    );
  }

  /**
   * Moves the difference focus to the next or previous hunk and brings it into
   * view. The target index is resolved by the same pure NavigationHelper.target
   * used by the editor change-navigation commands, fed the hunk indices as the
   * "changed lines" and the current active index as the cursor, so the walk
   * wraps around at both ends (past the last hunk returns to the first, before
   * the first returns to the last). With no hunks it is a safe no-op.
   *
   * @param {NavigationDirection} direction - Which way to step through the hunks
   */
  public goToDifference(direction: NavigationDirection): void {
    const count: number = this.host.getHunks().length;

    if (count === 0) {
      return;
    }

    /**
     * Hunk indices are 0..count-1; reuse the cursor-based target picker over
     * them so the wrap-around behaviour matches the editor navigation exactly.
     */
    const indices: number[] = Array.from({ length: count }, (_unused: unknown, index: number): number => index);
    const target: number | null = NavigationHelper.target(indices, this.activeHunkIndex, direction);

    if (target === null) {
      return;
    }

    this.activeHunkIndex = target;
    this.focusHunk(target);
  }

  /**
   * Highlights the hunk at the given index inside the diff and scrolls it into
   * view, so the difference the navigation buttons moved to is visible and
   * marked active. The target is the hunk's anchor row inside the rendered diff
   * (the same row that carries the inline revert affordance), so navigation
   * works against the diff itself now that the separate difference panel is
   * gone. Every other anchor row loses the active marker first. Patch mode has
   * no per-row anchors, so this is a safe no-op there.
   *
   * @param {number} index - The hunk index to focus
   */
  public focusHunk(index: number): void {
    const container: HTMLElement | undefined = this.host.diffContainer();

    if (!container) {
      return;
    }

    const anchors: HTMLElement[] = Array.from(
      container.querySelectorAll<HTMLElement>('.lct-hunk-anchor'),
    );

    anchors.forEach((anchor: HTMLElement): void => {
      const anchorIndex: number = Number(anchor.dataset.lctHunk);

      DomHelper.update(anchor, { classes: anchorIndex === index ? { add: 'is-active' } : { remove: 'is-active' } });
    });

    anchors
      .find((anchor: HTMLElement): boolean => Number(anchor.dataset.lctHunk) === index)
      ?.scrollIntoView({ block: 'nearest' });
  }

  /**
   * Enables or disables the next/previous difference buttons based on whether
   * the current diff has any hunks to walk, and drops a stale active index when
   * the diff no longer has that many hunks. A diff with zero hunks leaves both
   * buttons disabled so a click is an ignored no-op. Patch mode is also disabled:
   * it renders a plain <pre> with no per-row anchors to scroll to, so stepping
   * between differences has nothing to focus there.
   */
  public updateNavButtonsState(): void {
    const count: number = this.host.getHunks().length;
    const disabled: boolean = count === 0 || this.currentDisplayMode === DiffViewMode.patch;

    [this.navButtons.previous, this.navButtons.next].forEach((button: HTMLElement | undefined): void => {
      if (!button) {
        return;
      }

      (button as HTMLButtonElement).disabled = disabled;
      DomHelper.update(button, { classes: disabled ? { add: 'is-disabled' } : { remove: 'is-disabled' } });
    });

    /**
     * Forget a focus that no longer points at an existing hunk.
     */
    if (this.activeHunkIndex >= count) {
      this.activeHunkIndex = -1;
    }
  }
}
