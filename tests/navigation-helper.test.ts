import { describe, expect, it } from '@jest/globals';
import { NavigationHelper } from '@/helpers/navigation.helper';

/**
 * Tests for the next/previous change target selection (T5.4). They drive
 * NavigationHelper.target directly on a set of 0-based changed line positions
 * and a cursor line, which is the unit the navigation commands delegate to
 * before moving the real cursor. The guarantees under test are:
 * - "next" lands strictly after the cursor, "previous" strictly before it,
 * - a cursor sitting on a changed line still advances off it,
 * - the search wraps at both ends, and
 * - an empty change set yields no target.
 */
describe('NavigationHelper.target', () => {
  const changes: number[] = [2, 5, 9];

  describe('next', () => {
    it('jumps to the first change strictly after the cursor', () => {
      expect(NavigationHelper.target(changes, 0, 'next')).toBe(2);
      expect(NavigationHelper.target(changes, 3, 'next')).toBe(5);
    });

    it('advances off a changed line the cursor already sits on', () => {
      // Cursor on line 2 (a change) must move to the next change, not stay.
      expect(NavigationHelper.target(changes, 2, 'next')).toBe(5);
    });

    it('wraps to the first change when the cursor is at or past the last', () => {
      expect(NavigationHelper.target(changes, 9, 'next')).toBe(2);
      expect(NavigationHelper.target(changes, 42, 'next')).toBe(2);
    });
  });

  describe('previous', () => {
    it('jumps to the first change strictly before the cursor', () => {
      expect(NavigationHelper.target(changes, 10, 'previous')).toBe(9);
      expect(NavigationHelper.target(changes, 6, 'previous')).toBe(5);
    });

    it('retreats off a changed line the cursor already sits on', () => {
      // Cursor on line 5 (a change) must move to the previous change, not stay.
      expect(NavigationHelper.target(changes, 5, 'previous')).toBe(2);
    });

    it('wraps to the last change when the cursor is at or before the first', () => {
      expect(NavigationHelper.target(changes, 2, 'previous')).toBe(9);
      expect(NavigationHelper.target(changes, 0, 'previous')).toBe(9);
    });
  });

  describe('edge cases', () => {
    it('returns null when there are no changed lines', () => {
      expect(NavigationHelper.target([], 0, 'next')).toBeNull();
      expect(NavigationHelper.target([], 0, 'previous')).toBeNull();
    });

    it('returns the only change regardless of direction or cursor side', () => {
      expect(NavigationHelper.target([4], 1, 'next')).toBe(4);
      expect(NavigationHelper.target([4], 9, 'next')).toBe(4);
      expect(NavigationHelper.target([4], 9, 'previous')).toBe(4);
      expect(NavigationHelper.target([4], 1, 'previous')).toBe(4);
      // Cursor exactly on the only change wraps back to it.
      expect(NavigationHelper.target([4], 4, 'next')).toBe(4);
      expect(NavigationHelper.target([4], 4, 'previous')).toBe(4);
    });

    it('normalizes unsorted input with duplicates', () => {
      const messy: number[] = [9, 2, 5, 2, 9];

      expect(NavigationHelper.target(messy, 0, 'next')).toBe(2);
      expect(NavigationHelper.target(messy, 3, 'next')).toBe(5);
      expect(NavigationHelper.target(messy, 100, 'previous')).toBe(9);
    });
  });
});
