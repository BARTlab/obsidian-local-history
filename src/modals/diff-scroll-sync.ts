import type { DiffContainerResolver } from '@/modals/diff-scroll-sync.types';
import type { FunctionVoid, HTMLElementWithScrollSync } from '@/types';

/**
 * Scroll-synchronisation collaborator for the side-by-side diff view.
 *
 * Extracted from {@link HistoryModal} as a plain object the modal instantiates
 * and owns (per ADR-11: deep collaborators, not DI services). It owns
 * the deferred-setup timer and the per-container listener cleanup so the modal
 * no longer carries scroll-sync fields or methods; the modal just calls
 * {@link schedule} after rendering a side-by-side diff and {@link cleanup} on
 * every mode switch and on close.
 *
 * The host passes a {@link DiffContainerResolver} at construction so the
 * deferred callback can compare the container captured at schedule time against
 * the live one and bail if it was replaced, preserving the original guard.
 */
export class DiffScrollSync {
  /**
   * Handle of the pending deferred {@link setup} call, captured so a rapid mode
   * switch can cancel it before it attaches listeners to a replaced DOM.
   */
  protected timer: ReturnType<typeof setTimeout> | null = null;

  /**
   * @param {DiffContainerResolver} resolveContainer - Reads the host's live diff
   *   container, used both as the setup target and to detect container swaps.
   */
  public constructor(protected readonly resolveContainer: DiffContainerResolver) {}

  /**
   * Schedules scroll synchronisation for a freshly rendered side-by-side diff.
   * Uses `setTimeout(0)` to let the diff2html DOM mount first; the deferred
   * callback bails if the container was replaced (rapid mode switch) so no
   * listeners attach to stale DOM. Any previously pending schedule is left for
   * {@link cleanup}, which the host calls before every render.
   */
  public schedule(): void {
    const targetContainer: HTMLElementWithScrollSync | undefined = this.resolveContainer();

    this.timer = setTimeout((): void => {
      this.timer = null;

      if (this.resolveContainer() !== targetContainer) {
        return;
      }

      this.setup();
    }, 0);
  }

  /**
   * Cancels any pending deferred setup and detaches the scroll listeners from
   * the current diff container. Called when switching between diff modes or
   * closing the modal.
   */
  public cleanup(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);

      this.timer = null;
    }

    const container: HTMLElementWithScrollSync | undefined = this.resolveContainer();

    if (container?._scrollSyncCleanup) {
      container._scrollSyncCleanup();

      delete container._scrollSyncCleanup;
    }
  }

  /**
   * Finds the scrollable wrapper elements for both diff columns and adds the
   * listeners that mirror vertical and horizontal scroll between them. A
   * reentrancy guard (`isScrolling`, cleared on the next animation frame)
   * prevents the two listeners from echoing each other. The detach closure is
   * stored on the container so {@link cleanup} can remove the listeners.
   */
  protected setup(): void {
    const container: HTMLElementWithScrollSync | undefined = this.resolveContainer();

    if (!container) {
      return;
    }

    const wrappers = container.querySelectorAll('.d2h-side-column-wrapper') as NodeListOf<HTMLElement>;

    if (wrappers?.length !== 2) {
      return;
    }

    const [leftWrapper, rightWrapper] = wrappers;
    let isScrolling: boolean = false;

    // Synchronize scroll from left to right.
    const syncLeftToRight: FunctionVoid = (): void => {
      if (isScrolling) {
        return;
      }

      isScrolling = true;
      rightWrapper.scrollTop = leftWrapper.scrollTop;
      rightWrapper.scrollLeft = leftWrapper.scrollLeft;

      requestAnimationFrame((): void => {
        isScrolling = false;
      });
    };

    // Synchronize scroll from right to left.
    const syncRightToLeft: FunctionVoid = (): void => {
      if (isScrolling) {
        return;
      }

      isScrolling = true;
      leftWrapper.scrollTop = rightWrapper.scrollTop;
      leftWrapper.scrollLeft = rightWrapper.scrollLeft;

      requestAnimationFrame((): void => {
        isScrolling = false;
      });
    };

    leftWrapper.addEventListener('scroll', syncLeftToRight);
    rightWrapper.addEventListener('scroll', syncRightToLeft);

    // Store references so the listeners can be detached on cleanup.
    container._scrollSyncCleanup = (): void => {
      leftWrapper.removeEventListener('scroll', syncLeftToRight);
      rightWrapper.removeEventListener('scroll', syncRightToLeft);
    };
  }
}
