import { describe, expect, it } from '@jest/globals';
import { ChangeType } from '@/consts';
import { FileSnapshot } from '@/snapshots/file.snapshot';
import type { TrackerLine } from '@/lines/tracker.line';

/**
 * Characterization tests for the FileSnapshot model (T2.1). They drive the
 * snapshot directly (change/restore/add/remove and the raw shift helpers) and
 * encode the current expected behavior of the change-tracking state machine.
 */

const positionsWithType = (snapshot: FileSnapshot, type: ChangeType): number[] =>
  snapshot
    .getChanges(type)
    .simplify()
    .map((change): number => change.getLine())
    .sort((a: number, b: number): number => a - b);

// Ground-truth lookup of the live line at a position by scanning the tracker
// directly (first match in array order), used to assert the cached
// current-position index never drifts from the tracker it indexes.
const liveAt = (snapshot: FileSnapshot, pos: number): TrackerLine | null =>
  snapshot.tracker.find(
    (line: TrackerLine): boolean => line.existedInCurrent && line.currentPosition === pos
  ) ?? null;

describe('FileSnapshot construction', () => {
  it('seeds one original tracker per line', () => {
    const snapshot = new FileSnapshot('a\nb\nc');

    expect(snapshot.lines).toEqual(['a', 'b', 'c']);
    expect(snapshot.getLastStateLines()).toEqual(['a', 'b', 'c']);
    expect(snapshot.tracker).toHaveLength(3);
    expect(snapshot.tracker.every((line: TrackerLine): boolean => line.isStateOriginal())).toBe(true);
    expect(snapshot.getChangesLinesCount()).toBe(0);
  });

  it('reports no pending update for identical content', () => {
    const snapshot = new FileSnapshot('a\nb\nc');

    expect(snapshot.isNeedUpdate('a\nb\nc')).toBe(false);
    expect(snapshot.isNeedUpdate('a\nB\nc')).toBe(true);
  });
});

describe('FileSnapshot single-line change', () => {
  it('marks an edited original line as changed', () => {
    const snapshot = new FileSnapshot('a\nb\nc');

    snapshot.findCurrentLine(1)?.change('B');
    snapshot.updateChanges();

    expect(positionsWithType(snapshot, ChangeType.changed)).toEqual([1]);
    expect(snapshot.getChangesLinesCount()).toBe(1);
  });

  it('marks a line restored once its content returns to the original', () => {
    const snapshot = new FileSnapshot('a\nb\nc');
    const line: TrackerLine | null = snapshot.findCurrentLine(1);

    line?.change('B');
    line?.change('b');
    snapshot.updateChanges();

    expect(line?.isStateChanged()).toBe(false);
    expect(line?.isStateRestored()).toBe(true);
    expect(positionsWithType(snapshot, ChangeType.restored)).toEqual([1]);
  });
});

describe('FileSnapshot add and remove', () => {
  it('marks a freshly inserted line as added', () => {
    const snapshot = new FileSnapshot('a\nb');

    snapshot.restoreOrAddTracker(1);
    snapshot.updateChanges();

    expect(positionsWithType(snapshot, ChangeType.added)).toEqual([1]);
  });

  it('marks a removed original line as removed and shifts the rest up', () => {
    const snapshot = new FileSnapshot('a\nb\nc');
    const lineC: TrackerLine | null = snapshot.findCurrentLine(2);

    snapshot.removeTrackerOrLine(1);
    snapshot.updateChanges();

    expect(positionsWithType(snapshot, ChangeType.removed)).toEqual([1]);
    expect(lineC?.currentPosition).toBe(1);
  });

  it('drops an added-then-removed line without leaving a ghost change', () => {
    const snapshot = new FileSnapshot('a\nb');

    const added: TrackerLine = snapshot.restoreOrAddTracker(1);

    snapshot.removeTrackerOrLine(added);
    snapshot.updateChanges();

    expect(snapshot.getChangesLinesCount()).toBe(0);
  });
});

describe('FileSnapshot shift helpers', () => {
  it('shiftDown decrements current positions inside the range', () => {
    const snapshot = new FileSnapshot('a\nb\nc');
    const lineA: TrackerLine | null = snapshot.findCurrentLine(0);
    const lineB: TrackerLine | null = snapshot.findCurrentLine(1);
    const lineC: TrackerLine | null = snapshot.findCurrentLine(2);

    snapshot.shiftDown(1);

    expect(lineA?.currentPosition).toBe(0);
    expect(lineB?.currentPosition).toBe(0);
    expect(lineC?.currentPosition).toBe(1);
  });

  it('shiftUp increments current positions inside the range', () => {
    const snapshot = new FileSnapshot('a\nb\nc');
    const lineA: TrackerLine | null = snapshot.findCurrentLine(0);
    const lineC: TrackerLine | null = snapshot.findCurrentLine(2);

    snapshot.shiftUp(0);

    expect(lineA?.currentPosition).toBe(1);
    expect(lineC?.currentPosition).toBe(3);
  });
});

describe('FileSnapshot current-position index (T3.2)', () => {
  it('resolves findCurrentLine to the line living at the position', () => {
    const snapshot = new FileSnapshot('a\nb\nc');

    expect(snapshot.findCurrentLine(0)?.current).toBe('a');
    expect(snapshot.findCurrentLine(2)?.current).toBe('c');
    expect(snapshot.findCurrentLine(3)).toBeNull();
  });

  it('still honors the optional upper-bound guard', () => {
    const snapshot = new FileSnapshot('a\nb\nc');

    // The line is at position 2, so a range capped at 1 must miss it.
    expect(snapshot.findCurrentLine(2, 1)).toBeNull();
    expect(snapshot.findCurrentLine(2, 2)?.current).toBe('c');
  });

  it('rebuilds the index after a raw shift invalidates it', () => {
    const snapshot = new FileSnapshot('a\nb\nc');

    // Warm the lazy index, then shift every line up so cached positions go stale.
    snapshot.findCurrentLine(0);
    snapshot.shiftUp(0);

    // a@1, b@2, c@3 after the shift; nothing remains at 0.
    expect(snapshot.findCurrentLine(0)).toBeNull();
    expect(snapshot.findCurrentLine(1)?.current).toBe('a');
    expect(snapshot.findCurrentLine(3)?.current).toBe('c');

    for (let pos = -1; pos <= 4; pos++) {
      expect(snapshot.findCurrentLine(pos)).toBe(liveAt(snapshot, pos));
    }
  });

  it('matches a direct tracker scan after a mix of mutations', () => {
    const snapshot = new FileSnapshot('a\nb\nc\nd\ne');

    // Warm the index, then run mutations that each must invalidate it.
    snapshot.findCurrentLine(0);
    snapshot.moveTo(0, 2);
    snapshot.removeTrackerOrLine(1);
    snapshot.restoreOrAddTracker(0);
    snapshot.findCurrentLine(3)?.change('E2');

    for (let pos = -1; pos <= 6; pos++) {
      expect(snapshot.findCurrentLine(pos)).toBe(liveAt(snapshot, pos));
    }
  });

  it('finds a freshly added line through the index', () => {
    const snapshot = new FileSnapshot('a\nb');

    const added: TrackerLine = snapshot.restoreOrAddTracker(1);

    expect(snapshot.findCurrentLine(1)).toBe(added);
  });
});

describe('FileSnapshot.replaceBlock (per-hunk revert, T5.3)', () => {
  it('clears a changed line when its block is reverted to the original', () => {
    const snapshot = new FileSnapshot('a\nb\nc');

    // Two independent edits, then revert only the first back to the original.
    snapshot.findCurrentLine(0)?.change('A');
    snapshot.findCurrentLine(2)?.change('C');
    snapshot.updateChanges();
    expect(snapshot.getChangesLinesCount()).toBe(2);

    snapshot.replaceBlock(0, 1, ['a']);
    snapshot.updateState(['a', 'b', 'C']);
    snapshot.updateChanges();

    // The reverted line is no longer changed; the untouched edit survives.
    expect(positionsWithType(snapshot, ChangeType.changed)).toEqual([2]);
    expect(snapshot.findCurrentLine(0)?.isStateChanged()).toBe(false);
    expect(snapshot.getLastStateLines()).toEqual(['a', 'b', 'C']);
  });

  it('removes an added line when its insertion block is reverted', () => {
    const snapshot = new FileSnapshot('a\nb');

    // Insert a line, then revert that insertion (replace one current line with none).
    snapshot.restoreOrAddTracker(1)?.change('NEW');
    snapshot.updateState(['a', 'NEW', 'b']);
    snapshot.updateChanges();
    expect(positionsWithType(snapshot, ChangeType.added)).toEqual([1]);

    snapshot.replaceBlock(1, 1, []);
    snapshot.updateState(['a', 'b']);
    snapshot.updateChanges();

    expect(snapshot.getChangesLinesCount()).toBe(0);
    expect(snapshot.getLastStateLines()).toEqual(['a', 'b']);
  });

  it('re-inserts a removed original line when its deletion block is reverted', () => {
    const snapshot = new FileSnapshot('a\nb\nc');

    // Remove the middle line, then revert the deletion by inserting it back.
    snapshot.removeTrackerOrLine(1);
    snapshot.updateState(['a', 'c']);
    snapshot.updateChanges();
    expect(positionsWithType(snapshot, ChangeType.removed)).toEqual([1]);

    snapshot.replaceBlock(1, 0, ['b']);
    snapshot.updateState(['a', 'b', 'c']);
    snapshot.updateChanges();

    // The original line is back and the snapshot reports no pending changes.
    expect(snapshot.getChangesLinesCount()).toBe(0);
    expect(snapshot.getLastStateLines()).toEqual(['a', 'b', 'c']);
  });

  it('keeps later edits intact and correctly positioned when an earlier block is reverted', () => {
    const snapshot = new FileSnapshot('a\nb\nc\nd');

    // Insert a block early and edit a later line, then revert only the insertion.
    snapshot.restoreOrAddTracker(1)?.change('INS');
    snapshot.updateState(['a', 'INS', 'b', 'c', 'd']);
    snapshot.findCurrentLine(4)?.change('D');
    snapshot.updateState(['a', 'INS', 'b', 'c', 'D']);
    snapshot.updateChanges();
    expect(positionsWithType(snapshot, ChangeType.added)).toEqual([1]);
    expect(positionsWithType(snapshot, ChangeType.changed)).toEqual([4]);

    // Revert the insertion at position 1; the later edit must shift to line 3.
    snapshot.replaceBlock(1, 1, []);
    snapshot.updateState(['a', 'b', 'c', 'D']);
    snapshot.updateChanges();

    expect(positionsWithType(snapshot, ChangeType.added)).toEqual([]);
    expect(positionsWithType(snapshot, ChangeType.changed)).toEqual([3]);
    expect(snapshot.findCurrentLine(3)?.current).toBe('D');
  });
});
