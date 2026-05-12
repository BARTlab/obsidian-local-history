import { describe, expect, it } from '@jest/globals';
import { VersionLabelHelper } from '@/helpers/version-label.helper';

/**
 * Tests for the pure VersionLabelHelper (T02). The helper derives a human
 * action description (created / modified / cleared) plus the added/removed
 * line counts for a version, given the previous and current contents. It has
 * no Obsidian or DOM dependency, so the tests drive it directly with line
 * arrays.
 *
 * The three acceptance items map to: empty -> non-empty is "created",
 * non-empty -> empty is "cleared", non-empty -> different non-empty is
 * "modified" with the deltas reflecting the line-level diff.
 */

describe('VersionLabelHelper.describe', () => {
  describe('created kind (previous empty -> current non-empty)', () => {
    it('returns "created" when previous has no lines and current is non-empty', () => {
      const result = VersionLabelHelper.describe([], ['a', 'b']);

      expect(result.kind).toBe('created');
      expect(result.added).toBe(2);
      expect(result.removed).toBe(0);
    });

    it('treats a single empty-string line as empty content for the previous side', () => {
      const result = VersionLabelHelper.describe([''], ['hello']);

      expect(result.kind).toBe('created');
      expect(result.added).toBeGreaterThan(0);
    });
  });

  describe('cleared kind (previous non-empty -> current empty)', () => {
    it('returns "cleared" when previous is non-empty and current has no lines', () => {
      const result = VersionLabelHelper.describe(['a', 'b'], []);

      expect(result.kind).toBe('cleared');
      expect(result.removed).toBe(2);
      expect(result.added).toBe(0);
    });

    it('treats a single empty-string line as empty content for the current side', () => {
      const result = VersionLabelHelper.describe(['line'], ['']);

      expect(result.kind).toBe('cleared');
      expect(result.removed).toBeGreaterThan(0);
    });
  });

  describe('modified kind (both non-empty and differ)', () => {
    it('returns "modified" with the added and removed line counts', () => {
      const result = VersionLabelHelper.describe(['a', 'b', 'c'], ['a', 'B', 'c', 'd']);

      expect(result.kind).toBe('modified');
      expect(result.added).toBe(2);
      expect(result.removed).toBe(1);
    });

    it('counts only changed lines, not context', () => {
      const result = VersionLabelHelper.describe(['a', 'b', 'c'], ['a', 'B', 'c']);

      expect(result.kind).toBe('modified');
      expect(result.added).toBe(1);
      expect(result.removed).toBe(1);
    });

    it('reports zero deltas when contents are identical and non-empty', () => {
      const result = VersionLabelHelper.describe(['a', 'b'], ['a', 'b']);

      expect(result.kind).toBe('modified');
      expect(result.added).toBe(0);
      expect(result.removed).toBe(0);
    });
  });

  describe('edge cases', () => {
    it('handles null/undefined inputs as empty content', () => {
      const result = VersionLabelHelper.describe(undefined as unknown as string[], ['x']);

      expect(result.kind).toBe('created');
      expect(result.added).toBe(1);
    });

    it('returns modified with zero deltas when both sides are empty', () => {
      const result = VersionLabelHelper.describe([], []);

      expect(result.kind).toBe('modified');
      expect(result.added).toBe(0);
      expect(result.removed).toBe(0);
    });
  });
});
