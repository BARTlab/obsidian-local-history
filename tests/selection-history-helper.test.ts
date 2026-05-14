import { describe, expect, it } from '@jest/globals';
import { SelectionHistoryHelper, type SelectableVersion } from '@/helpers/selection-history.helper';

/**
 * Tests for the pure SelectionHistoryHelper (T08). The helper inspects each
 * version's diff against its previous neighbour (the history baseline for the
 * oldest entry) and returns the ids whose added or removed lines contain the
 * selection text. The three acceptance items map to: addition match, removal
 * match, and the exclusion case where the selection text does not appear on
 * either side of any neighbour diff.
 */

describe('SelectionHistoryHelper.match', () => {
  const baseline: string[] = ['alpha', 'beta'];

  describe('addition match (selection text appears on the added side)', () => {
    it('includes a version whose neighbour diff adds a line containing the selection', () => {
      const versions: SelectableVersion[] = [
        { id: 'v1', lines: ['alpha', 'beta', 'needle here'] },
      ];

      const result = SelectionHistoryHelper.match(versions, baseline, 'needle');

      expect(result.has('v1')).toBe(true);
      expect(result.size).toBe(1);
    });

    it('matches a multi-line selection when every selection line is added by the same neighbour diff', () => {
      const versions: SelectableVersion[] = [
        { id: 'v1', lines: ['alpha', 'beta', 'first added', 'second added'] },
      ];

      const result = SelectionHistoryHelper.match(versions, baseline, 'first added\nsecond added');

      expect(result.has('v1')).toBe(true);
    });
  });

  describe('removal match (selection text appears on the removed side)', () => {
    it('includes a version whose neighbour diff removes a line containing the selection', () => {
      const versions: SelectableVersion[] = [
        { id: 'v1', lines: ['alpha', 'beta', 'doomed line'] },
        { id: 'v2', lines: ['alpha', 'beta'] },
      ];

      const result = SelectionHistoryHelper.match(versions, baseline, 'doomed');

      expect(result.has('v2')).toBe(true);
      expect(result.has('v1')).toBe(true);
    });

    it('treats removal-only edits as matches when the selection text vanished at that point', () => {
      const versions: SelectableVersion[] = [
        { id: 'v1', lines: ['alpha', 'beta', 'secret marker'] },
        { id: 'v2', lines: ['alpha', 'beta'] },
      ];

      const result = SelectionHistoryHelper.match(versions, baseline, 'secret marker');

      expect(result.has('v2')).toBe(true);
    });
  });

  describe('exclusion (neighbour diff neither adds nor removes the selection)', () => {
    it('excludes a version whose neighbour diff does not touch the selection text', () => {
      const versions: SelectableVersion[] = [
        { id: 'v1', lines: ['alpha', 'beta', 'unrelated change'] },
      ];

      const result = SelectionHistoryHelper.match(versions, baseline, 'needle');

      expect(result.has('v1')).toBe(false);
    });

    it('excludes a version where the selection coexists with content but was not added or removed at this point', () => {
      const baselineWithText: string[] = ['alpha', 'persistent text', 'beta'];
      const versions: SelectableVersion[] = [
        { id: 'v1', lines: ['alpha', 'persistent text', 'gamma'] },
      ];

      const result = SelectionHistoryHelper.match(versions, baselineWithText, 'persistent text');

      expect(result.has('v1')).toBe(false);
    });

    it('returns an empty set when the selection is empty or whitespace-only', () => {
      const versions: SelectableVersion[] = [
        { id: 'v1', lines: ['alpha', 'beta', 'needle'] },
      ];

      expect(SelectionHistoryHelper.match(versions, baseline, '').size).toBe(0);
      expect(SelectionHistoryHelper.match(versions, baseline, '   \n  ').size).toBe(0);
    });

    it('excludes a multi-line selection when only one of its lines appears on the added side', () => {
      const versions: SelectableVersion[] = [
        { id: 'v1', lines: ['alpha', 'beta', 'first added'] },
      ];

      const result = SelectionHistoryHelper.match(versions, baseline, 'first added\nsecond added');

      expect(result.has('v1')).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('handles an empty version list as no matches', () => {
      const result = SelectionHistoryHelper.match([], baseline, 'needle');

      expect(result.size).toBe(0);
    });

    it('handles a null/undefined versions input safely', () => {
      const result = SelectionHistoryHelper.match(
        undefined as unknown as SelectableVersion[],
        baseline,
        'needle',
      );

      expect(result.size).toBe(0);
    });

    it('treats a missing baseline as empty (the oldest version is diffed against [])', () => {
      const versions: SelectableVersion[] = [
        { id: 'v1', lines: ['hello needle'] },
      ];

      const result = SelectionHistoryHelper.match(
        versions,
        undefined as unknown as string[],
        'needle',
      );

      expect(result.has('v1')).toBe(true);
    });

    it('walks neighbour-to-neighbour, not always against the baseline', () => {
      const versions: SelectableVersion[] = [
        { id: 'v1', lines: ['alpha', 'beta', 'first'] },
        { id: 'v2', lines: ['alpha', 'beta', 'first', 'late addition'] },
      ];

      const result = SelectionHistoryHelper.match(versions, baseline, 'late addition');

      // v2 added the line vs v1; v1 did not touch it.
      expect(result.has('v2')).toBe(true);
      expect(result.has('v1')).toBe(false);
    });
  });
});
