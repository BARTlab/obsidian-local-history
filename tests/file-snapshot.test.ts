import { describe, expect, it } from '@jest/globals';
import { ChangeType } from '@/consts';
import { FileSnapshot } from '@/snapshots/file.snapshot';
import type { TrackerLine } from '@/lines/tracker.line';
import type { SerializedFileSnapshot } from '@/types';

/**
 * Characterization tests for the FileSnapshot model. They drive the
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
  snapshot.getTrackerLines().find(
    (line: TrackerLine): boolean => line.existedInCurrent && line.currentPosition === pos
  ) ?? null;

describe('FileSnapshot construction', () => {
  it('seeds one original tracker per line', () => {
    const snapshot = new FileSnapshot('a\nb\nc');

    expect(snapshot.lines).toEqual(['a', 'b', 'c']);
    expect(snapshot.getLastStateLines()).toEqual(['a', 'b', 'c']);
    expect(snapshot.getTrackerLines()).toHaveLength(3);
    expect(snapshot.getTrackerLines().every((line: TrackerLine): boolean => line.isStateOriginal())).toBe(true);
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

describe('FileSnapshot current-position index', () => {
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

describe('FileSnapshot.replaceBlock (per-hunk revert)', () => {
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

  it('places every replacement on its expected current position when the block straddles tracked and removed lines', () => {
    // Start from a, b, c, d, e; remove the middle line b so the tracker holds
    // a removed marker at removedAtPosition=1 alongside a@0, c@1, d@2, e@3.
    const snapshot = new FileSnapshot('a\nb\nc\nd\ne');

    snapshot.removeTrackerOrLine(1);
    snapshot.updateState(['a', 'c', 'd', 'e']);
    snapshot.updateChanges();
    expect(positionsWithType(snapshot, ChangeType.removed)).toEqual([1]);

    // Replace the leading block (a, c) with three lines so the new block
    // straddles the removed marker at position 1: removeCount=2, newLines.length=3.
    snapshot.replaceBlock(0, 2, ['X', 'Y', 'Z']);
    snapshot.updateState(['X', 'Y', 'Z', 'd', 'e']);
    snapshot.updateChanges();

    // Every replacement line lands on its expected current position and the
    // trailing tracked lines slide by the net offset (+1) without drift.
    expect(snapshot.findCurrentLine(0)?.current).toBe('X');
    expect(snapshot.findCurrentLine(1)?.current).toBe('Y');
    expect(snapshot.findCurrentLine(2)?.current).toBe('Z');
    expect(snapshot.findCurrentLine(3)?.current).toBe('d');
    expect(snapshot.findCurrentLine(4)?.current).toBe('e');
    expect(snapshot.findCurrentLine(5)).toBeNull();

    // The cached current-position index matches a direct tracker scan, so the
    // straddle did not desynchronize the index from the underlying tracker.
    for (let pos = -1; pos <= 6; pos++) {
      expect(snapshot.findCurrentLine(pos)).toBe(liveAt(snapshot, pos));
    }

    // The new live document holds exactly five lines: no doomed-or-restored
    // ghost stays on a current position past the visible end.
    expect(snapshot.getLastStateLines()).toEqual(['X', 'Y', 'Z', 'd', 'e']);
  });
});

describe('FileSnapshot.getChangedPositions (navigation source)', () => {
  it('returns no positions for a pristine snapshot', () => {
    const snapshot = new FileSnapshot('a\nb\nc');

    expect(snapshot.getChangedPositions()).toEqual([]);
  });

  it('collects changed, added and removed positions in ascending order', () => {
    const snapshot = new FileSnapshot('a\nb\nc\nd\ne');

    // Change line 0, change line 3, and remove line 1 (which leaves a removed
    // marker at position 1 and shifts the lines below it up).
    snapshot.findCurrentLine(0)?.change('A');
    snapshot.findCurrentLine(3)?.change('D');
    snapshot.removeTrackerOrLine(1);
    snapshot.updateState(['A', 'c', 'D', 'e']);
    snapshot.updateChanges();

    // Navigation offers exactly the highlighted lines: line 0 changed, line 1
    // (the removal marker), line 2 changed. The same set the decorations draw,
    // ascending, with no entry for the untouched trailing line.
    expect(snapshot.getChangedPositions()).toEqual([0, 1, 2]);
    expect(positionsWithType(snapshot, ChangeType.changed)).toEqual([0, 2]);
    expect(positionsWithType(snapshot, ChangeType.removed)).toEqual([1]);
  });

  it('reflects the current state and includes restored lines like the highlights', () => {
    const snapshot = new FileSnapshot('a\nb\nc');

    snapshot.findCurrentLine(0)?.change('A');
    snapshot.findCurrentLine(2)?.change('C');
    snapshot.updateChanges();
    expect(snapshot.getChangedPositions()).toEqual([0, 2]);

    // Edit line 0 back to its original: it becomes a restored line, which is
    // still highlighted, so navigation keeps offering it. Line 2 stays changed.
    snapshot.findCurrentLine(0)?.change('a');
    snapshot.updateChanges();

    expect(snapshot.getChangedPositions()).toEqual([0, 2]);
    expect(positionsWithType(snapshot, ChangeType.restored)).toEqual([0]);
    expect(positionsWithType(snapshot, ChangeType.changed)).toEqual([2]);
  });

  it('can scope navigation to a subset of change types', () => {
    const snapshot = new FileSnapshot('a\nb\nc');

    // One restored line (0) and one changed line (2).
    snapshot.findCurrentLine(0)?.change('A');
    snapshot.findCurrentLine(0)?.change('a');
    snapshot.findCurrentLine(2)?.change('C');
    snapshot.updateChanges();

    // Restricting to "changed" drops the restored line from the navigation set.
    expect(snapshot.getChangedPositions(ChangeType.changed)).toEqual([2]);
  });
});

describe('FileSnapshot tombstone and move markers', () => {
  it('leaves deletedTimestamp and movedIntoAt undefined on a fresh snapshot', () => {
    const snapshot = new FileSnapshot('a\nb');

    expect(snapshot.deletedTimestamp).toBeUndefined();
    expect(snapshot.movedIntoAt).toBeUndefined();
    expect(snapshot.isTombstone()).toBe(false);
    expect(snapshot.isMovedIn()).toBe(false);
  });

  it('reports isTombstone according to deletedTimestamp presence', () => {
    const live = new FileSnapshot('a');
    const tombstone = new FileSnapshot('a');

    tombstone.deletedTimestamp = 42;

    expect(live.isTombstone()).toBe(false);
    expect(tombstone.isTombstone()).toBe(true);
  });

  it('reports isMovedIn according to movedIntoAt presence', () => {
    const pristine = new FileSnapshot('a');
    const moved = new FileSnapshot('a');

    moved.movedIntoAt = 7;

    expect(pristine.isMovedIn()).toBe(false);
    expect(moved.isMovedIn()).toBe(true);
  });

  it('omits both fields from toJSON when unset', () => {
    const snapshot = new FileSnapshot('a\nb');
    const payload = snapshot.toJSON();

    expect(Object.prototype.hasOwnProperty.call(payload, 'deletedTimestamp')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(payload, 'movedIntoAt')).toBe(false);
  });

  it('serializes deletedTimestamp on a tombstone and omits movedIntoAt when unset', () => {
    const snapshot = new FileSnapshot('a\nb');

    snapshot.deletedTimestamp = 123456;

    const payload = snapshot.toJSON();

    expect(payload.deletedTimestamp).toBe(123456);
    expect(Object.prototype.hasOwnProperty.call(payload, 'movedIntoAt')).toBe(false);
  });

  it('round-trips deletedTimestamp through fromJSON losslessly', () => {
    const original = new FileSnapshot('a\nb');

    original.deletedTimestamp = 999;

    const restored = FileSnapshot.fromJSON(original.toJSON());

    expect(restored.deletedTimestamp).toBe(999);
    expect(restored.isTombstone()).toBe(true);
    expect(restored.movedIntoAt).toBeUndefined();
    expect(restored.isMovedIn()).toBe(false);
  });

  it('round-trips movedIntoAt through fromJSON losslessly', () => {
    const original = new FileSnapshot('x');

    original.movedIntoAt = 555;

    const restored = FileSnapshot.fromJSON(original.toJSON());

    expect(restored.movedIntoAt).toBe(555);
    expect(restored.isMovedIn()).toBe(true);
    expect(restored.deletedTimestamp).toBeUndefined();
    expect(restored.isTombstone()).toBe(false);
  });

  it('round-trips both markers together through fromJSON', () => {
    const original = new FileSnapshot('x\ny');

    original.deletedTimestamp = 1;
    original.movedIntoAt = 2;

    const restored = FileSnapshot.fromJSON(original.toJSON());

    expect(restored.isTombstone()).toBe(true);
    expect(restored.isMovedIn()).toBe(true);
    expect(restored.deletedTimestamp).toBe(1);
    expect(restored.movedIntoAt).toBe(2);
  });

  it('rebuilds isTombstone/isMovedIn from a synthetic serialized payload', () => {
    const payload: SerializedFileSnapshot = {
      path: 'gone/x.md',
      lineBreak: '\n',
      timestamp: 100,
      lines: ['a'],
      state: ['a'],
      tracker: [],
      versions: [],
      deletedTimestamp: 200,
      movedIntoAt: 150,
    };

    const restored = FileSnapshot.fromJSON(payload);

    expect(restored.isTombstone()).toBe(true);
    expect(restored.isMovedIn()).toBe(true);
    expect(restored.deletedTimestamp).toBe(200);
    expect(restored.movedIntoAt).toBe(150);
  });
});
