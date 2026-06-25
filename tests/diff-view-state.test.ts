/** @jest-environment jsdom */

import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { DiffOutputFormatType, DiffViewMode, NavigationDirection } from '@/consts';
import { DiffViewState } from '@/modals/diff-view-state';
import type { DiffViewStateHost } from '@/modals/diff-view-state';
import type * as Diff from 'diff';

/**
 * Tests for {@link DiffViewState}, the diff-view-state collaborator the
 * history modal owns. Extracted from the 2246-LOC modal, where the mode/nav
 * state was untestable; these run under jsdom and cover the behaviour the
 * toolbar relies on:
 *
 * - the active-mode highlight follows the current display mode across the four
 *   modes (and resets cleanly when the mode changes),
 * - next/previous difference navigation walks the hunk indices with wrap-around
 *   and a no-op on zero hunks, marking and scrolling the matching anchor row,
 * - the nav buttons disable when there is nothing to walk (no hunks, or patch
 *   mode which has no per-row anchors), and
 * - a stale active index is dropped when the diff shrinks below it.
 */
describe('DiffViewState', () => {
  let container: HTMLElement;
  let hunks: Diff.StructuredPatchHunk[];

  /**
   * jsdom does not implement scrollIntoView; the focus path calls it on the
   * matched anchor, so a no-op stub keeps the behaviour observable without it
   * throwing.
   */
  beforeAll((): void => {
    (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = (): void => {
      // no-op under jsdom
    };
  });

  /**
   * Builds the host port over a live container and a mutable hunk list, matching
   * how the modal feeds the state its live render.
   *
   * @return {DiffViewStateHost} The host port
   */
  const makeHost = (): DiffViewStateHost => ({
    diffContainer: (): HTMLElement | undefined => container,
    getHunks: (): Diff.StructuredPatchHunk[] => hunks,
  });

  /**
   * Mounts `count` anchor rows numbered 0..count-1 the same way the gutter
   * handler marks them, so focus can find and mark the right one.
   *
   * @param {number} count - How many anchor rows to mount
   */
  const mountAnchors = (count: number): void => {
    for (let index = 0; index < count; index++) {
      const anchor = document.createElement('div');

      anchor.className = 'lct-hunk-anchor';
      anchor.dataset.lctHunk = String(index);
      container.appendChild(anchor);
    }
  };

  /**
   * Builds a button element registered against a state's mode-button registry.
   *
   * @return {HTMLButtonElement} The button
   */
  const makeButton = (): HTMLButtonElement => document.createElement('button');

  beforeEach((): void => {
    container = document.createElement('div');
    document.body.appendChild(container);
    hunks = [];
  });

  describe('active-mode highlight', () => {
    it('marks only the button for the current display mode as active', () => {
      const state = new DiffViewState(makeHost());

      state.modeButtons.patch = makeButton();
      state.modeButtons.inline = makeButton();
      state.modeButtons.lineByLine = makeButton();
      state.modeButtons.sideBySide = makeButton();

      state.currentDisplayMode = DiffViewMode.inline;
      state.updateButtonActiveStates();

      expect(state.modeButtons.inline?.classList.contains('is-active')).toBe(true);
      expect(state.modeButtons.patch?.classList.contains('is-active')).toBe(false);
      expect(state.modeButtons.lineByLine?.classList.contains('is-active')).toBe(false);
      expect(state.modeButtons.sideBySide?.classList.contains('is-active')).toBe(false);
      expect(state.getActiveButton()).toBe(state.modeButtons.inline);
    });

    it('moves the highlight when the display mode changes', () => {
      const state = new DiffViewState(makeHost());

      state.modeButtons.lineByLine = makeButton();
      state.modeButtons.sideBySide = makeButton();

      state.currentDisplayMode = DiffOutputFormatType.line;
      state.updateButtonActiveStates();
      expect(state.modeButtons.lineByLine?.classList.contains('is-active')).toBe(true);

      state.currentDisplayMode = DiffOutputFormatType.side;
      state.updateButtonActiveStates();
      expect(state.modeButtons.lineByLine?.classList.contains('is-active')).toBe(false);
      expect(state.modeButtons.sideBySide?.classList.contains('is-active')).toBe(true);
    });
  });

  describe('difference navigation', () => {
    it('focuses the first hunk on the first next and the last on the first previous', () => {
      hunks = [{}, {}, {}] as Diff.StructuredPatchHunk[];
      const state = new DiffViewState(makeHost());

      state.goToDifference(NavigationDirection.next);
      expect(state.activeHunkIndex).toBe(0);

      state.activeHunkIndex = -1;
      state.goToDifference(NavigationDirection.previous);
      expect(state.activeHunkIndex).toBe(2);
    });

    it('wraps around at both ends', () => {
      hunks = [{}, {}, {}] as Diff.StructuredPatchHunk[];
      const state = new DiffViewState(makeHost());

      state.activeHunkIndex = 2;
      state.goToDifference(NavigationDirection.next);
      expect(state.activeHunkIndex).toBe(0);

      state.activeHunkIndex = 0;
      state.goToDifference(NavigationDirection.previous);
      expect(state.activeHunkIndex).toBe(2);
    });

    it('marks the focused anchor active and clears the others', () => {
      hunks = [{}, {}, {}] as Diff.StructuredPatchHunk[];
      mountAnchors(3);
      const state = new DiffViewState(makeHost());

      state.focusHunk(1);

      const anchors = Array.from(container.querySelectorAll<HTMLElement>('.lct-hunk-anchor'));

      expect(anchors[0].classList.contains('is-active')).toBe(false);
      expect(anchors[1].classList.contains('is-active')).toBe(true);
      expect(anchors[2].classList.contains('is-active')).toBe(false);
    });

    it('scrolls the focused anchor into view', () => {
      hunks = [{}, {}] as Diff.StructuredPatchHunk[];
      mountAnchors(2);
      const state = new DiffViewState(makeHost());
      const target = container.querySelectorAll<HTMLElement>('.lct-hunk-anchor')[1];
      const scrollSpy = jest.spyOn(target, 'scrollIntoView');

      state.focusHunk(1);

      expect(scrollSpy).toHaveBeenCalledWith({ block: 'nearest' });
    });

    it('is a safe no-op with no hunks', () => {
      const state = new DiffViewState(makeHost());

      state.goToDifference(NavigationDirection.next);
      expect(state.activeHunkIndex).toBe(-1);
    });
  });

  describe('nav-button enablement', () => {
    it('enables the buttons when the diff has hunks to walk', () => {
      hunks = [{}, {}] as Diff.StructuredPatchHunk[];
      const state = new DiffViewState(makeHost());

      state.navButtons.previous = makeButton();
      state.navButtons.next = makeButton();
      state.currentDisplayMode = DiffOutputFormatType.side;

      state.updateNavButtonsState();

      expect((state.navButtons.previous as HTMLButtonElement).disabled).toBe(false);
      expect((state.navButtons.next as HTMLButtonElement).disabled).toBe(false);
      expect(state.navButtons.next?.classList.contains('is-disabled')).toBe(false);
    });

    it('disables the buttons when there are no hunks', () => {
      hunks = [];
      const state = new DiffViewState(makeHost());

      state.navButtons.previous = makeButton();
      state.navButtons.next = makeButton();
      state.currentDisplayMode = DiffOutputFormatType.side;

      state.updateNavButtonsState();

      expect((state.navButtons.previous as HTMLButtonElement).disabled).toBe(true);
      expect((state.navButtons.next as HTMLButtonElement).disabled).toBe(true);
      expect(state.navButtons.previous?.classList.contains('is-disabled')).toBe(true);
    });

    it('disables the buttons in patch mode even when hunks exist', () => {
      hunks = [{}, {}] as Diff.StructuredPatchHunk[];
      const state = new DiffViewState(makeHost());

      state.navButtons.next = makeButton();
      state.currentDisplayMode = DiffViewMode.patch;

      state.updateNavButtonsState();

      expect((state.navButtons.next as HTMLButtonElement).disabled).toBe(true);
    });

    it('drops a stale active index that points past the current hunks', () => {
      hunks = [{}] as Diff.StructuredPatchHunk[];
      const state = new DiffViewState(makeHost());

      state.activeHunkIndex = 3;
      state.updateNavButtonsState();

      expect(state.activeHunkIndex).toBe(-1);
    });

    it('keeps a still-valid active index', () => {
      hunks = [{}, {}, {}] as Diff.StructuredPatchHunk[];
      const state = new DiffViewState(makeHost());

      state.activeHunkIndex = 1;
      state.updateNavButtonsState();

      expect(state.activeHunkIndex).toBe(1);
    });
  });
});
