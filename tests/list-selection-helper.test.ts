import { describe, expect, it } from '@jest/globals';
import { type ListSelectionDirection, ListSelectionHelper } from '@/helpers/list-selection.helper';

/**
 * Tests for the history modal's keyboard navigation of the version rail. They
 * drive ListSelectionHelper.step directly on the ordered list of selectable ids
 * (the synthetic baseline first, then the visible versions newest-first) and the
 * currently selected id, which is the pure unit the modal delegates to when an
 * up/down arrow is pressed while the list holds focus.
 *
 * The guarantees under test mirror the modal behaviour:
 * - down moves toward the end of the list, up toward the start,
 * - the walk clamps at both ends (it does NOT wrap, unlike the diff hunk
 *   navigation), so an edge press keeps the current selection,
 * - a current id missing from the list (a selection hidden by the rail filter)
 *   starts the walk from the top, and
 * - an empty list yields no target, so an arrow press is a safe no-op.
 */
describe('ListSelectionHelper.step', () => {
  const ids: string[] = ['original', 'v3', 'v2', 'v1'];

  const step = (currentId: string, direction: ListSelectionDirection): string | null =>
    ListSelectionHelper.step(ids, currentId, direction);

  describe('down', () => {
    it('moves to the next entry below', () => {
      expect(step('original', 'down')).toBe('v3');
      expect(step('v3', 'down')).toBe('v2');
      expect(step('v2', 'down')).toBe('v1');
    });

    it('clamps on the last entry', () => {
      expect(step('v1', 'down')).toBe('v1');
    });
  });

  describe('up', () => {
    it('moves to the entry above', () => {
      expect(step('v1', 'up')).toBe('v2');
      expect(step('v2', 'up')).toBe('v3');
      expect(step('v3', 'up')).toBe('original');
    });

    it('clamps on the first entry (the baseline)', () => {
      expect(step('original', 'up')).toBe('original');
    });
  });

  describe('edge cases', () => {
    it('starts from the top when the current id is not in the list', () => {
      // A selection hidden by the rail filter: down lands on the first entry, up
      // stays clamped at the top.
      expect(step('missing', 'down')).toBe('v3');
      expect(step('missing', 'up')).toBe('original');
    });

    it('resolves to the only entry in either direction', () => {
      expect(ListSelectionHelper.step(['original'], 'original', 'down')).toBe('original');
      expect(ListSelectionHelper.step(['original'], 'original', 'up')).toBe('original');
    });

    it('yields no target for an empty list, so an arrow press is a no-op', () => {
      expect(ListSelectionHelper.step([], 'original', 'down')).toBeNull();
      expect(ListSelectionHelper.step([], 'original', 'up')).toBeNull();
    });

    it('tolerates a nullish list', () => {
      expect(ListSelectionHelper.step(undefined as unknown as string[], 'original', 'down')).toBeNull();
    });
  });
});
