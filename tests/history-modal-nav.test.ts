import { describe, expect, it } from '@jest/globals';
import { NavigationDirection } from '@/consts';
import * as NavigationHelper from '@/helpers/navigation.helper';

/**
 * Tests for the history modal next/previous difference navigation. The
 * modal steps between diff hunks by reusing the same pure
 * NavigationHelper.target the editor change-navigation commands use, fed the
 * hunk indices (0..count-1) as the "changed lines" and the currently focused
 * hunk index as the cursor. This exercises that hunk-index selection directly,
 * which is the headless-testable core of the feature (the actual scroll and
 * active-row highlight are DOM behaviours checked manually in Obsidian).
 *
 * The guarantees under test mirror the toolbar buttons:
 * - the first "next" (from no focus, index -1) lands on the first hunk and the
 *   first "previous" lands on the last,
 * - stepping advances by one in the requested direction,
 * - the walk wraps at both ends (past the last returns to the first, before the
 *   first returns to the last),
 * - a single hunk always resolves to itself, and
 * - zero hunks yield no target, so a navigation click is a safe no-op.
 */
describe('history modal difference navigation (hunk-index selection)', () => {
  /**
   * Mirrors how the modal builds the hunk-index set and resolves the next
   * difference: indices are 0..count-1 and the active index plays the cursor.
   *
   * @param {number} count - The number of hunks in the current diff
   * @param {number} activeIndex - The currently focused hunk index, or -1
   * @param {NavigationDirection} direction - Which way to step
   * @return {number | null} The resolved hunk index, or null when there is none
   */
  const step = (count: number, activeIndex: number, direction: NavigationDirection): number | null => {
    const indices: number[] = Array.from({ length: count }, (_unused: unknown, index: number): number => index);

    return NavigationHelper.target(indices, activeIndex, direction);
  };

  describe(NavigationDirection.next, () => {
    it('focuses the first hunk when nothing is focused yet', () => {
      expect(step(3, -1, NavigationDirection.next)).toBe(0);
    });

    it('advances to the following hunk', () => {
      expect(step(3, 0, NavigationDirection.next)).toBe(1);
      expect(step(3, 1, NavigationDirection.next)).toBe(2);
    });

    it('wraps from the last hunk back to the first', () => {
      expect(step(3, 2, NavigationDirection.next)).toBe(0);
    });
  });

  describe(NavigationDirection.previous, () => {
    it('focuses the last hunk when nothing is focused yet', () => {
      // The cursor at -1 lies before every index, so "previous" wraps to the end.
      expect(step(3, -1, NavigationDirection.previous)).toBe(2);
    });

    it('retreats to the preceding hunk', () => {
      expect(step(3, 2, NavigationDirection.previous)).toBe(1);
      expect(step(3, 1, NavigationDirection.previous)).toBe(0);
    });

    it('wraps from the first hunk back to the last', () => {
      expect(step(3, 0, NavigationDirection.previous)).toBe(2);
    });
  });

  describe('edge cases', () => {
    it('always resolves to the only hunk in either direction', () => {
      expect(step(1, -1, NavigationDirection.next)).toBe(0);
      expect(step(1, -1, NavigationDirection.previous)).toBe(0);
      expect(step(1, 0, NavigationDirection.next)).toBe(0);
      expect(step(1, 0, NavigationDirection.previous)).toBe(0);
    });

    it('yields no target when there are no hunks, so navigation is a no-op', () => {
      expect(step(0, -1, NavigationDirection.next)).toBeNull();
      expect(step(0, -1, NavigationDirection.previous)).toBeNull();
    });
  });
});
