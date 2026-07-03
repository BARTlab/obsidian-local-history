import { describe, expect, it } from '@jest/globals';
import * as HunkHelper from '@/helpers/hunk.helper';

/**
 * Tests for the per-hunk revert logic. They drive HunkHelper directly on
 * arrays of lines, which is the unit the history modal delegates to when a user
 * reverts a single hunk. The core guarantees under test are:
 * - reverting one hunk restores exactly that block to the base, and
 * - it leaves every other hunk intact with correct offsets, including when the
 *   reverted hunk changes the line count (insertions and deletions).
 */
describe('HunkHelper.diff', () => {
  it('returns no hunks when base and current are identical', () => {
    expect(HunkHelper.diff(['a', 'b', 'c'], ['a', 'b', 'c'])).toEqual([]);
  });

  it('produces one hunk per contiguous change block', () => {
    const base = ['l1', 'l2', 'l3', 'l4', 'l5'];
    const current = ['l1', 'L2X', 'l3', 'l4', 'L5Y'];

    const hunks = HunkHelper.diff(base, current);

    expect(hunks).toHaveLength(2);
  });

  it('encodes a last-line deletion as a pure-deletion hunk', () => {
    // Deleting the final line of a file with no trailing newline must diff as a
    // clean pure deletion (newLines === 0), not a mixed "no newline" hunk, so
    // the gutter revert path can find it. The reinsertion point is the end of
    // the current text: newStart === currentLines.length + 1 (3 here).
    const [hunk] = HunkHelper.diff(['A', 'B', 'C'], ['A', 'B']);

    expect(hunk.newLines).toBe(0);
    expect(hunk.newStart).toBe(3);
    expect(HunkHelper.baseLinesForHunk(hunk)).toEqual(['C']);
  });

  it('encodes a multi-line trailing deletion as a pure-deletion hunk', () => {
    // Deleting several trailing lines collapses to a single pure-deletion hunk
    // whose reinsertion point is one past the surviving line.
    const [hunk] = HunkHelper.diff(['A', 'B', 'C'], ['A']);

    expect(hunk.newLines).toBe(0);
    expect(hunk.newStart).toBe(2);
    expect(HunkHelper.baseLinesForHunk(hunk)).toEqual(['B', 'C']);
  });
});

describe('HunkHelper.revertHunk', () => {
  it('reverts a single changed line back to the base', () => {
    const base = ['a', 'b', 'c'];
    const current = ['a', 'B', 'c'];
    const [hunk] = HunkHelper.diff(base, current);

    expect(HunkHelper.revertHunk(current, hunk)).toEqual(['a', 'b', 'c']);
  });

  it('reverting one hunk leaves the other hunks intact', () => {
    const base = ['l1', 'l2', 'l3', 'l4', 'l5'];
    const current = ['l1', 'L2X', 'l3', 'l4', 'L5Y'];
    const [first, second] = HunkHelper.diff(base, current);

    // Revert only the first block: the second change must survive untouched.
    expect(HunkHelper.revertHunk(current, first)).toEqual(['l1', 'l2', 'l3', 'l4', 'L5Y']);

    // Revert only the second block: the first change must survive untouched.
    expect(HunkHelper.revertHunk(current, second)).toEqual(['l1', 'L2X', 'l3', 'l4', 'l5']);
  });

  it('keeps offsets correct when an earlier hunk added lines', () => {
    // The current text has an inserted block before a later change. Reverting
    // the later change must target the right region despite the size shift.
    const base = ['a', 'b', 'c', 'd'];
    const current = ['a', 'INS1', 'INS2', 'b', 'c', 'D'];
    const hunks = HunkHelper.diff(base, current);

    expect(hunks).toHaveLength(2);

    const last = hunks[hunks.length - 1];

    // Reverting the trailing change restores 'd' and keeps the insertion.
    expect(HunkHelper.revertHunk(current, last)).toEqual(['a', 'INS1', 'INS2', 'b', 'c', 'd']);

    // Reverting the insertion removes the added lines and keeps the trailing change.
    expect(HunkHelper.revertHunk(current, hunks[0])).toEqual(['a', 'b', 'c', 'D']);
  });

  it('reverts a pure insertion by removing the added lines', () => {
    const base = ['a', 'b'];
    const current = ['a', 'NEW', 'b'];
    const [hunk] = HunkHelper.diff(base, current);

    expect(HunkHelper.revertHunk(current, hunk)).toEqual(['a', 'b']);
  });

  it('reverts a pure deletion by re-inserting the removed lines', () => {
    const base = ['a', 'GONE', 'c'];
    const current = ['a', 'c'];
    const [hunk] = HunkHelper.diff(base, current);

    expect(HunkHelper.revertHunk(current, hunk)).toEqual(['a', 'GONE', 'c']);
  });

  it('reverts an insertion at the start of the file', () => {
    const base = ['b', 'c'];
    const current = ['NEW', 'b', 'c'];
    const [hunk] = HunkHelper.diff(base, current);

    expect(HunkHelper.revertHunk(current, hunk)).toEqual(['b', 'c']);
  });

  it('reverts an insertion at the end of the file', () => {
    const base = ['a', 'b'];
    const current = ['a', 'b', 'NEW'];
    const [hunk] = HunkHelper.diff(base, current);

    expect(HunkHelper.revertHunk(current, hunk)).toEqual(['a', 'b']);
  });

  it('reverts a deletion at the end of the file', () => {
    const base = ['a', 'GONE'];
    const current = ['a'];
    const [hunk] = HunkHelper.diff(base, current);

    expect(HunkHelper.revertHunk(current, hunk)).toEqual(['a', 'GONE']);
  });

  it('does not mutate the input array', () => {
    const base = ['a', 'b', 'c'];
    const current = ['a', 'B', 'c'];
    const [hunk] = HunkHelper.diff(base, current);

    HunkHelper.revertHunk(current, hunk);

    expect(current).toEqual(['a', 'B', 'c']);
  });

  it('reverting every hunk in turn reconstructs the base', () => {
    const base = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6'];
    const current = ['l1', 'L2', 'l3', 'INS', 'l4', 'l5', 'L6'];

    let working = [...current];

    // Recompute hunks against the base after each revert so indices stay valid,
    // then revert the first remaining hunk until none are left.
    for (let guard = 0; guard < 50; guard++) {
      const hunks = HunkHelper.diff(base, working);

      if (hunks.length === 0) {
        break;
      }

      working = HunkHelper.revertHunk(working, hunks[0]);
    }

    expect(working).toEqual(base);
  });

  it('returns a copy unchanged when the hunk is missing', () => {
    const current = ['a', 'b'];

    expect(HunkHelper.revertHunk(current, undefined as never)).toEqual(['a', 'b']);
  });
});

describe('HunkHelper.hunkAtLine', () => {
  it('resolves the hunk covering a changed line', () => {
    const base = ['a', 'b', 'c'];
    const current = ['a', 'B', 'c'];
    const hunks = HunkHelper.diff(base, current);

    // The change is on the 2nd line (0-based index 1).
    expect(HunkHelper.hunkAtLine(hunks, 1)).toBe(hunks[0]);
  });

  it('resolves the hunk covering any line of a multi-line added block', () => {
    const base = ['a', 'd'];
    const current = ['a', 'b', 'c', 'd'];
    const hunks = HunkHelper.diff(base, current);

    // The inserted block spans current indices 1 and 2; both map to that hunk.
    expect(HunkHelper.hunkAtLine(hunks, 1)).toBe(hunks[0]);
    expect(HunkHelper.hunkAtLine(hunks, 2)).toBe(hunks[0]);
  });

  it('returns null for a line outside every changed block', () => {
    const base = ['a', 'b', 'c'];
    const current = ['a', 'B', 'c'];
    const hunks = HunkHelper.diff(base, current);

    // The unchanged 1st and 3rd lines have no revert target.
    expect(HunkHelper.hunkAtLine(hunks, 0)).toBeNull();
    expect(HunkHelper.hunkAtLine(hunks, 2)).toBeNull();
  });

  it('skips a pure deletion since it occupies no current line', () => {
    const base = ['a', 'GONE', 'c'];
    const current = ['a', 'c'];
    const [hunk] = HunkHelper.diff(base, current);

    expect(hunk.newLines).toBe(0);
    // No current line belongs to the deletion, so no line resolves to it.
    expect(HunkHelper.hunkAtLine([hunk], 0)).toBeNull();
    expect(HunkHelper.hunkAtLine([hunk], 1)).toBeNull();
  });

  it('picks the correct block when several changes coexist', () => {
    const base = ['l1', 'l2', 'l3', 'l4', 'l5'];
    const current = ['l1', 'L2X', 'l3', 'l4', 'L5Y'];
    const [first, second] = HunkHelper.diff(base, current);

    expect(HunkHelper.hunkAtLine([first, second], 1)).toBe(first);
    expect(HunkHelper.hunkAtLine([first, second], 4)).toBe(second);
    // The gap between the two changes resolves to neither.
    expect(HunkHelper.hunkAtLine([first, second], 2)).toBeNull();
  });

  it('returns null for non-array input', () => {
    expect(HunkHelper.hunkAtLine(undefined as never, 0)).toBeNull();
  });
});
