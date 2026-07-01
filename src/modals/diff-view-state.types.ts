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
  patch?: HTMLElement;
  inline?: HTMLElement;
  lineByLine?: HTMLElement;
  sideBySide?: HTMLElement;
}

/**
 * References to the next/previous difference navigation buttons, kept so they
 * can be disabled when the current diff has no hunks to walk.
 */
export interface NavButtonRefs {
  previous?: HTMLElement;
  next?: HTMLElement;
}
