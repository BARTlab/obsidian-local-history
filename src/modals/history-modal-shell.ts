import { DomHelper } from '@/helpers/dom.helper';

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

/**
 * Shared three-pane shell for the two history modals. It owns the layout spine
 * both modals build identically - the body, the main pane, the toolbar, the
 * above-diff notice, the diff block, the side-by-side column header, and the
 * diff container - plus the relocation of the modal's native close button into
 * the toolbar. Each modal supplies only the parts that genuinely differ (the
 * body modifier, the navigation columns, and the diff container's focus wiring)
 * through {@link HistoryModalShellConfig}, so the two shells can never drift in
 * region classes or close-button placement.
 *
 * The shell is a plain object the modal instantiates against its live content /
 * modal elements (per ADR-11: deep collaborators, not DI services).
 */
export class HistoryModalShell {
  /**
   * @param {HTMLElement} contentEl - The modal content element the body is appended to.
   * @param {HTMLElement} modalEl - The modal root element the close button lives on.
   */
  public constructor(
    protected readonly contentEl: HTMLElement,
    protected readonly modalEl: HTMLElement,
  ) {}

  /**
   * Builds the shell spine and returns the created regions. The caller fills the
   * navigation columns through {@link HistoryModalShellConfig.buildColumns}, then
   * populates the returned `toolbarEl` and calls {@link relocateCloseButton} so
   * the close button lands as the last toolbar control.
   *
   * @param {HistoryModalShellConfig} config - The per-modal shell configuration
   * @return {HistoryModalShellRegions} The created layout regions
   */
  public build(config: HistoryModalShellConfig): HistoryModalShellRegions {
    const bodyEl: HTMLElement = DomHelper.create({
      tag: 'div',
      classes: ['lct-modal-body', ...(config.bodyModifier ?? [])],
      container: this.contentEl,
    });

    config.buildColumns(bodyEl);

    const mainEl: HTMLElement = DomHelper.create({
      tag: 'div',
      classes: 'lct-modal-main',
      container: bodyEl,
    });

    const toolbarEl: HTMLElement = DomHelper.create({
      tag: 'div',
      classes: 'lct-modal-toolbar',
      container: mainEl,
    });

    const noticeEl: HTMLElement = DomHelper.create({
      tag: 'div',
      classes: ['lct-diff-notice', 'lct-diff-notice-hidden'],
      container: mainEl,
    });

    /**
     * The diff block bundles the side-by-side column header and the diff output
     * in one bordered box, so the header reads as a fixed row at the top of the
     * block and the diff fills the rest below it.
     */
    const blockEl: HTMLElement = DomHelper.create({
      tag: 'div',
      classes: 'lct-diff-block',
      container: mainEl,
    });

    const columnsHeaderEl: HTMLElement = DomHelper.create({
      tag: 'div',
      classes: ['lct-diff-columns', 'lct-diff-columns-hidden'],
      container: blockEl,
    });

    const diffContainerEl: HTMLElement = DomHelper.create({
      tag: 'div',
      classes: 'diff-container',
      container: blockEl,
      attributes: config.diffContainerAttributes,
      events: config.diffContainerEvents,
    });

    return { bodyEl, mainEl, toolbarEl, noticeEl, columnsHeaderEl, diffContainerEl };
  }

  /**
   * Pulls the modal's native close button out of its floating top-right corner
   * and appends it as the last control in the toolbar, so it lines up with the
   * other icon buttons instead of hovering apart. It drops the raised round look
   * for the plain .clickable-icon look the rest of the row uses; the static
   * position is restored in CSS. A no-op when the close button is absent.
   *
   * @param {HTMLElement} toolbarEl - The toolbar the close button is moved into
   */
  public relocateCloseButton(toolbarEl: HTMLElement): void {
    const closeButtonEl: HTMLElement | null = this.modalEl.querySelector<HTMLElement>('.modal-close-button');

    if (closeButtonEl) {
      closeButtonEl.classList.remove('mod-raised');
      closeButtonEl.classList.add('clickable-icon');
      toolbarEl.appendChild(closeButtonEl);
    }
  }
}
