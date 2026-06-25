/** @jest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { DiffScrollSync } from '@/modals/diff-scroll-sync';
import type { HTMLElementWithScrollSync } from '@/types';

/**
 * Tests for {@link DiffScrollSync}, the scroll-synchronisation
 * collaborator the history modal owns for its side-by-side diff. Extracted from
 * the 2246-LOC modal, where it was untestable; these run under jsdom and cover
 * the behaviour the modal relies on:
 *
 * - schedule defers setup so the diff2html DOM can mount first, then mirrors
 *   vertical and horizontal scroll between the two side columns,
 * - the deferred setup bails when the container was swapped before the timer
 *   fired (rapid mode switch), so no listeners attach to stale DOM,
 * - the reentrancy guard stops the mirrored scroll from echoing back, and
 * - cleanup cancels a pending schedule and detaches the listeners.
 *
 * requestAnimationFrame is stubbed to run synchronously so the reentrancy guard
 * (which clears on the next frame) is observable without real timing.
 */
describe('DiffScrollSync', () => {
  let container: HTMLElementWithScrollSync;
  let leftWrapper: HTMLElement;
  let rightWrapper: HTMLElement;

  /**
   * Builds a side-by-side diff container with the two scrollable column
   * wrappers the collaborator pairs, matching the markup diff2html emits.
   *
   * @return {HTMLElementWithScrollSync} The mounted container
   */
  const buildContainer = (): HTMLElementWithScrollSync => {
    const root = document.createElement('div') as HTMLElementWithScrollSync;

    leftWrapper = document.createElement('div');
    rightWrapper = document.createElement('div');
    leftWrapper.className = 'd2h-side-column-wrapper';
    rightWrapper.className = 'd2h-side-column-wrapper';
    root.appendChild(leftWrapper);
    root.appendChild(rightWrapper);
    document.body.appendChild(root);

    return root;
  };

  beforeEach((): void => {
    jest.useFakeTimers();
    // Run rAF synchronously so the reentrancy guard's "clear on next frame"
    // happens within the test without real animation timing.
    jest.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(
      (callback: FrameRequestCallback): number => {
        callback(0);

        return 0;
      },
    );
    container = buildContainer();
  });

  afterEach((): void => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('mirrors a left-column scroll onto the right column after the deferred setup', () => {
    const sync = new DiffScrollSync((): HTMLElementWithScrollSync => container);

    sync.schedule();
    // No listeners until the deferred setup fires.
    leftWrapper.scrollTop = 40;
    leftWrapper.dispatchEvent(new Event('scroll'));
    expect(rightWrapper.scrollTop).toBe(0);

    jest.runAllTimers();

    leftWrapper.scrollTop = 120;
    leftWrapper.scrollLeft = 15;
    leftWrapper.dispatchEvent(new Event('scroll'));

    expect(rightWrapper.scrollTop).toBe(120);
    expect(rightWrapper.scrollLeft).toBe(15);
  });

  it('mirrors a right-column scroll onto the left column', () => {
    const sync = new DiffScrollSync((): HTMLElementWithScrollSync => container);

    sync.schedule();
    jest.runAllTimers();

    rightWrapper.scrollTop = 77;
    rightWrapper.scrollLeft = 9;
    rightWrapper.dispatchEvent(new Event('scroll'));

    expect(leftWrapper.scrollTop).toBe(77);
    expect(leftWrapper.scrollLeft).toBe(9);
  });

  it('does not echo a mirrored scroll back to the originating column', () => {
    const sync = new DiffScrollSync((): HTMLElementWithScrollSync => container);

    sync.schedule();
    jest.runAllTimers();

    // The right column tracks scroll requests so we can prove the guard stops
    // the left->right handler from re-triggering the right->left handler.
    const rightSets: number[] = [];

    Object.defineProperty(rightWrapper, 'scrollTop', {
      configurable: true,
      get: (): number => 0,
      set: (value: number): void => {
        rightSets.push(value);
        // Mirror a real wrapper: a programmatic scrollTop change emits a scroll
        // event, which without the guard would bounce back to the left column.
        rightWrapper.dispatchEvent(new Event('scroll'));
      },
    });

    leftWrapper.scrollLeft = 5;
    leftWrapper.dispatchEvent(new Event('scroll'));

    // The left->right sync set the right column exactly once; the echoed scroll
    // event was swallowed by the reentrancy guard, so no second write occurred.
    expect(rightSets).toEqual([0]);
  });

  it('attaches no listeners when the container was swapped before the timer fired', () => {
    let live: HTMLElementWithScrollSync | undefined = container;
    const sync = new DiffScrollSync((): HTMLElementWithScrollSync | undefined => live);

    sync.schedule();
    // Rapid mode switch: the modal replaced the diff container before setup ran.
    live = buildContainer();
    jest.runAllTimers();

    leftWrapper.scrollTop = 50;
    leftWrapper.dispatchEvent(new Event('scroll'));
    // The new container's right column is untouched: setup bailed on the swap.
    expect(rightWrapper.scrollTop).toBe(0);
  });

  it('does nothing when the side columns are not both present', () => {
    rightWrapper.remove();
    const sync = new DiffScrollSync((): HTMLElementWithScrollSync => container);

    sync.schedule();
    jest.runAllTimers();

    // No cleanup closure is stored because setup found fewer than two wrappers.
    expect(container._scrollSyncCleanup).toBeUndefined();
  });

  it('cancels a pending schedule on cleanup so no listeners attach', () => {
    const sync = new DiffScrollSync((): HTMLElementWithScrollSync => container);

    sync.schedule();
    sync.cleanup();
    jest.runAllTimers();

    leftWrapper.scrollTop = 33;
    leftWrapper.dispatchEvent(new Event('scroll'));
    expect(rightWrapper.scrollTop).toBe(0);
  });

  it('detaches the listeners on cleanup so a later scroll no longer mirrors', () => {
    const sync = new DiffScrollSync((): HTMLElementWithScrollSync => container);

    sync.schedule();
    jest.runAllTimers();
    expect(container._scrollSyncCleanup).toBeDefined();

    sync.cleanup();
    expect(container._scrollSyncCleanup).toBeUndefined();

    leftWrapper.scrollTop = 64;
    leftWrapper.dispatchEvent(new Event('scroll'));
    expect(rightWrapper.scrollTop).toBe(0);
  });
});
