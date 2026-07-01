import { DIFF_SCROLL_STEP_PX, ListSelectionDirection, VersionListEdge } from '@/consts';
import type { KeyboardControllerHost } from '@/modals/keyboard-controller.types';

/**
 * Keyboard-navigation collaborator for the history modal.
 *
 * Extracted from {@link HistoryModal} as a plain object the modal instantiates
 * and owns (per ADR-11: deep collaborators, not DI services). It owns the two
 * keydown handlers - the version rail (arrows move the selection, Home/End jump
 * to the ends, Delete/Backspace drop the selected version) and the diff pane
 * (arrows nudge the scroll, PageUp/PageDown move by almost a pane, Home/End jump
 * to the ends) - and resolves the active diff scroller across the four view
 * modes. It stays stateless about the modal, walking the rail through the owned
 * {@link VersionList} and reading the live diff container back through
 * {@link KeyboardControllerHost}.
 */
export class KeyboardController {
  /**
   * @param {KeyboardControllerHost} host - The modal port the controller reads
   *   its shared state through and routes the delete flow to.
   */
  public constructor(protected readonly host: KeyboardControllerHost) {}

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
  public handleVersionsKeydown(event: KeyboardEvent): void {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.host.versionList.moveSelection(ListSelectionDirection.down);

        return;
      case 'ArrowUp':
        event.preventDefault();
        this.host.versionList.moveSelection(ListSelectionDirection.up);

        return;
      case 'Home':
        event.preventDefault();
        this.host.versionList.moveSelectionToEdge(VersionListEdge.first);

        return;
      case 'End':
        event.preventDefault();
        this.host.versionList.moveSelectionToEdge(VersionListEdge.last);

        return;
      case 'Delete':
      case 'Backspace':
        event.preventDefault();
        this.host.confirmRemoveSelectedVersion();

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
  public handleDiffKeydown(event: KeyboardEvent): void {
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
   * Resolves the scrollable element of the diff pane for the active view mode:
   * the patch container, the inline container, the line-by-line wrapper, or the
   * first side-by-side column wrapper (its scroll is mirrored to the other
   * column by the scroll-sync). Returns null before any diff is rendered.
   *
   * @return {HTMLElement | null} The diff scroll container, or null
   */
  protected getDiffScroller(): HTMLElement | null {
    return this.host.diffContainer()?.querySelector<HTMLElement>(
      '.lct-patch-container, .lct-inline-container, .d2h-wrapper.d2h-line, .d2h-side-column-wrapper',
    ) ?? null;
  }
}
