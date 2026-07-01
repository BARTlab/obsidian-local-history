/** The layout regions the shell builds and hands back to the owning modal. */
export interface HistoryModalShellRegions {
  /** The two-column body (navigation columns on the left, main pane on the right). */
  bodyEl: HTMLElement;
  /** The right content column, stacking the toolbar above the diff block. */
  mainEl: HTMLElement;
  /** The top toolbar inside the main column, above the diff. */
  toolbarEl: HTMLElement;
  /** The above-diff notice banner, hidden until a caller reveals it. */
  noticeEl: HTMLElement;
  /** The side-by-side column header, hidden until a caller reveals it. */
  columnsHeaderEl: HTMLElement;
  /** The diff output container the renderer writes into. */
  diffContainerEl: HTMLElement;
}

/** Per-modal configuration for the parts of the shell that legitimately differ. */
export interface HistoryModalShellConfig {
  /** Extra class(es) added to the body alongside the shared `lct-modal-body`. */
  bodyModifier?: string[];
  /**
   * Builds the navigation column(s) between the body and the main pane. The file
   * modal builds a single version rail here; the folder modal builds the rail
   * plus the middle tree column. Called after the body exists and before the
   * main pane, so the columns land ahead of the main pane in DOM order.
   *
   * @param {HTMLElement} bodyEl - The body the columns are appended to
   */
  buildColumns(bodyEl: HTMLElement): void;
  /** Attributes set on the diff container (the file modal makes it focusable). */
  diffContainerAttributes?: Record<string, string>;
  /** Event listeners bound to the diff container (the file modal's key scroll). */
  diffContainerEvents?: Record<string, (event: Event) => void>;
}
