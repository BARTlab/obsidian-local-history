import * as DomHelper from '@/helpers/dom.helper';
import type { DiffHeaderTranslator } from '@/modals/diff-header-controller.types';

/**
 * Shared diff-header logic for the two history modals: the above-diff notice
 * banner and the side-by-side column header. Both modals build the same two
 * regions and toggle them the same way; only the decision of when to show them
 * and which labels to use differs, and that stays with each modal. The
 * controller owns the DOM mechanics - revealing / hiding the notice with its
 * text, and revealing / hiding the two-column header with the picked base label
 * on the left and the current-state label (single-owned here) on the right - so
 * the notice and header can never drift between the file and folder modals.
 *
 * The controller reads its regions through lazy accessors so it can be built
 * before the shell exists (a plain deep collaborator, not a DI service).
 */
export class DiffHeaderController {
  /**
   * @param {() => HTMLElement | undefined} noticeEl - The live notice element, or undefined pre-shell.
   * @param {() => HTMLElement | undefined} columnsHeaderEl - The live column header, or undefined pre-shell.
   * @param {DiffHeaderTranslator} translator - Resolves the current-column label.
   */
  public constructor(
    protected readonly noticeEl: () => HTMLElement | undefined,
    protected readonly columnsHeaderEl: () => HTMLElement | undefined,
    protected readonly translator: DiffHeaderTranslator,
  ) {}

  /**
   * Shows the above-diff notice with the given text, or hides it when the text
   * is null. A hidden notice keeps its previous text (nothing is cleared), so a
   * later reveal without new text repaints the last banner.
   *
   * @param {string | null} text - The notice text, or null to hide the banner
   */
  public updateNotice(text: string | null): void {
    const noticeEl: HTMLElement | undefined = this.noticeEl();

    if (!noticeEl) {
      return;
    }

    DomHelper.update(noticeEl, {
      text: text ?? undefined,
      classes: text ? { remove: 'lct-diff-notice-hidden' } : { add: 'lct-diff-notice-hidden' },
    });
  }

  /**
   * Shows the side-by-side column header with the given base label on the left
   * and the current-state label on the right, or hides it when the base label is
   * null. The caller decides visibility (side-by-side mode, and for the folder
   * modal a resolved delta) by passing null to hide; the controller never
   * inspects the display mode itself.
   *
   * @param {string | null} baseLabel - The left-column label, or null to hide the header
   */
  public updateColumnsHeader(baseLabel: string | null): void {
    const columnsHeaderEl: HTMLElement | undefined = this.columnsHeaderEl();

    if (!columnsHeaderEl) {
      return;
    }

    if (baseLabel === null) {
      DomHelper.update(columnsHeaderEl, { classes: { add: 'lct-diff-columns-hidden' } });

      return;
    }

    DomHelper.update(columnsHeaderEl, {
      classes: { remove: 'lct-diff-columns-hidden' },
      children: [
        { tag: 'div', classes: 'lct-diff-column-title', text: baseLabel },
        { tag: 'div', classes: 'lct-diff-column-title', text: this.translator.t('modal.version.current') },
      ],
    });
  }
}
