import { describe, expect, it } from 'vitest';
import { ChangeType } from '@/consts';
import { FileSnapshot } from '@/snapshots/file.snapshot';
import { SnapshotCodec } from '@/snapshots/snapshot-codec';
import type { TrackerLine } from '@/lines/tracker.line';
import type { SerializedFileSnapshot } from '@/types';

/**
 * Characterization tests for the FileSnapshot model. They drive the
 * snapshot directly (change/restore/add/remove and the raw shift helpers) and
 * encode the current expected behavior of the change-tracking state machine.
 */

const positionsWithType = (snapshot: FileSnapshot, type: ChangeType): number[] =>
  snapshot
    .content.getChanges(type)
    .simplify()
    .map((change): number => change.getLine())
    .sort((a: number, b: number): number => a - b);

// Ground-truth lookup of the live line at a position by scanning the tracker
// directly (first match in array order), used to assert the cached
// current-position index never drifts from the tracker it indexes.
const liveAt = (snapshot: FileSnapshot, pos: number): TrackerLine | null =>
  snapshot.trackers.getTrackerLines().find(
    (line: TrackerLine): boolean => line.existedInCurrent && line.currentPosition === pos
  ) ?? null;

describe('FileSnapshot construction', () => {
  it('seeds one original tracker per line', () => {
    const snapshot = new FileSnapshot('a\nb\nc');

    expect(snapshot.content.lines).toEqual(['a', 'b', 'c']);
    expect(snapshot.content.getLastStateLines()).toEqual(['a', 'b', 'c']);
    expect(snapshot.trackers.getTrackerLines()).toHaveLength(3);
    expect(snapshot.trackers.getTrackerLines().every((line: TrackerLine): boolean => line.isStateOriginal())).toBe(true);
    expect(snapshot.content.getChangesLinesCount()).toBe(0);
  });

  it('reports no pending update for identical content', () => {
    const snapshot = new FileSnapshot('a\nb\nc');

    expect(snapshot.isNeedUpdate('a\nb\nc')).toBe(false);
    expect(snapshot.isNeedUpdate('a\nB\nc')).toBe(true);
  });

  it('decomposes mixed CRLF/LF content into one tracker per editor line', () => {
    // A file mixing '\r\n' and a lone '\n' must split on /\r?\n/, matching the
    // editor and change detector, so the baseline holds a tracker per real line
    // rather than merging the lone-LF pair into a composite 'b\nc' entry.
    const snapshot = new FileSnapshot('a\r\nb\nc', '\r\n');

    expect(snapshot.content.lines).toEqual(['a', 'b', 'c']);
    expect(snapshot.trackers.getTrackerLines()).toHaveLength(3);
    expect(snapshot.trackers.findCurrentLine(2)?.current).toBe('c');

    // No tracker carries a raw line break (no composite 'b\nc' survived).
    const carriesBreak = (line: TrackerLine): boolean =>
      /[\r\n]/.test(line.original ?? '') || /[\r\n]/.test(line.current ?? '');

    expect(snapshot.trackers.getTrackerLines().some(carriesBreak)).toBe(false);
  });
});

describe('FileSnapshot single-line change', () => {
  it('marks an edited original line as changed', () => {
    const snapshot = new FileSnapshot('a\nb\nc');

    snapshot.trackers.findCurrentLine(1)?.change('B');
    snapshot.updateChanges();

    expect(positionsWithType(snapshot, ChangeType.changed)).toEqual([1]);
    expect(snapshot.content.getChangesLinesCount()).toBe(1);
  });

  it('marks a line restored once its content returns to the original', () => {
    const snapshot = new FileSnapshot('a\nb\nc');
    const line: TrackerLine | null = snapshot.trackers.findCurrentLine(1);

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

    snapshot.trackers.restoreOrAddTracker(1);
    snapshot.updateChanges();

    expect(positionsWithType(snapshot, ChangeType.added)).toEqual([1]);
  });

  it('marks a removed original line as removed and shifts the rest up', () => {
    const snapshot = new FileSnapshot('a\nb\nc');
    const lineC: TrackerLine | null = snapshot.trackers.findCurrentLine(2);

    snapshot.trackers.removeTrackerOrLine(1);
    snapshot.updateChanges();

    expect(positionsWithType(snapshot, ChangeType.removed)).toEqual([1]);
    expect(lineC?.currentPosition).toBe(1);
  });

  it('drops an added-then-removed line without leaving a ghost change', () => {
    const snapshot = new FileSnapshot('a\nb');

    const added: TrackerLine = snapshot.trackers.restoreOrAddTracker(1);

    snapshot.trackers.removeTrackerOrLine(added);
    snapshot.updateChanges();

    expect(snapshot.content.getChangesLinesCount()).toBe(0);
  });
});

describe('FileSnapshot shift helpers', () => {
  it('shiftDown decrements current positions inside the range', () => {
    const snapshot = new FileSnapshot('a\nb\nc');
    const lineA: TrackerLine | null = snapshot.trackers.findCurrentLine(0);
    const lineB: TrackerLine | null = snapshot.trackers.findCurrentLine(1);
    const lineC: TrackerLine | null = snapshot.trackers.findCurrentLine(2);

    snapshot.trackers.shiftDown(1);

    expect(lineA?.currentPosition).toBe(0);
    expect(lineB?.currentPosition).toBe(0);
    expect(lineC?.currentPosition).toBe(1);
  });

  it('shiftUp increments current positions inside the range', () => {
    const snapshot = new FileSnapshot('a\nb\nc');
    const lineA: TrackerLine | null = snapshot.trackers.findCurrentLine(0);
    const lineC: TrackerLine | null = snapshot.trackers.findCurrentLine(2);

    snapshot.trackers.shiftUp(0);

    expect(lineA?.currentPosition).toBe(1);
    expect(lineC?.currentPosition).toBe(3);
  });
});

describe('FileSnapshot current-position index', () => {
  it('resolves findCurrentLine to the line living at the position', () => {
    const snapshot = new FileSnapshot('a\nb\nc');

    expect(snapshot.trackers.findCurrentLine(0)?.current).toBe('a');
    expect(snapshot.trackers.findCurrentLine(2)?.current).toBe('c');
    expect(snapshot.trackers.findCurrentLine(3)).toBeNull();
  });

  it('still honors the optional upper-bound guard', () => {
    const snapshot = new FileSnapshot('a\nb\nc');

    // The line is at position 2, so a range capped at 1 must miss it.
    expect(snapshot.trackers.findCurrentLine(2, 1)).toBeNull();
    expect(snapshot.trackers.findCurrentLine(2, 2)?.current).toBe('c');
  });

  it('rebuilds the index after a raw shift invalidates it', () => {
    const snapshot = new FileSnapshot('a\nb\nc');

    // Warm the lazy index, then shift every line up so cached positions go stale.
    snapshot.trackers.findCurrentLine(0);
    snapshot.trackers.shiftUp(0);

    // a@1, b@2, c@3 after the shift; nothing remains at 0.
    expect(snapshot.trackers.findCurrentLine(0)).toBeNull();
    expect(snapshot.trackers.findCurrentLine(1)?.current).toBe('a');
    expect(snapshot.trackers.findCurrentLine(3)?.current).toBe('c');

    for (let pos = -1; pos <= 4; pos++) {
      expect(snapshot.trackers.findCurrentLine(pos)).toBe(liveAt(snapshot, pos));
    }
  });

  it('matches a direct tracker scan after a mix of mutations', () => {
    const snapshot = new FileSnapshot('a\nb\nc\nd\ne');

    // Warm the index, then run mutations that each must invalidate it.
    snapshot.trackers.findCurrentLine(0);
    snapshot.trackers.moveTo(0, 2);
    snapshot.trackers.removeTrackerOrLine(1);
    snapshot.trackers.restoreOrAddTracker(0);
    snapshot.trackers.findCurrentLine(3)?.change('E2');

    for (let pos = -1; pos <= 6; pos++) {
      expect(snapshot.trackers.findCurrentLine(pos)).toBe(liveAt(snapshot, pos));
    }
  });

  it('finds a freshly added line through the index', () => {
    const snapshot = new FileSnapshot('a\nb');

    const added: TrackerLine = snapshot.trackers.restoreOrAddTracker(1);

    expect(snapshot.trackers.findCurrentLine(1)).toBe(added);
  });
});

describe('FileSnapshot.replaceBlock (per-hunk revert)', () => {
  it('clears a changed line when its block is reverted to the original', () => {
    const snapshot = new FileSnapshot('a\nb\nc');

    // Two independent edits, then revert only the first back to the original.
    snapshot.trackers.findCurrentLine(0)?.change('A');
    snapshot.trackers.findCurrentLine(2)?.change('C');
    snapshot.updateChanges();
    expect(snapshot.content.getChangesLinesCount()).toBe(2);

    snapshot.trackers.replaceBlock(0, 1, ['a']);
    snapshot.content.updateState(['a', 'b', 'C']);
    snapshot.updateChanges();

    // The reverted line is no longer changed; the untouched edit survives.
    expect(positionsWithType(snapshot, ChangeType.changed)).toEqual([2]);
    expect(snapshot.trackers.findCurrentLine(0)?.isStateChanged()).toBe(false);
    expect(snapshot.content.getLastStateLines()).toEqual(['a', 'b', 'C']);
  });

  it('removes an added line when its insertion block is reverted', () => {
    const snapshot = new FileSnapshot('a\nb');

    // Insert a line, then revert that insertion (replace one current line with none).
    snapshot.trackers.restoreOrAddTracker(1)?.change('NEW');
    snapshot.content.updateState(['a', 'NEW', 'b']);
    snapshot.updateChanges();
    expect(positionsWithType(snapshot, ChangeType.added)).toEqual([1]);

    snapshot.trackers.replaceBlock(1, 1, []);
    snapshot.content.updateState(['a', 'b']);
    snapshot.updateChanges();

    expect(snapshot.content.getChangesLinesCount()).toBe(0);
    expect(snapshot.content.getLastStateLines()).toEqual(['a', 'b']);
  });

  it('re-inserts a removed original line when its deletion block is reverted', () => {
    const snapshot = new FileSnapshot('a\nb\nc');

    // Remove the middle line, then revert the deletion by inserting it back.
    snapshot.trackers.removeTrackerOrLine(1);
    snapshot.content.updateState(['a', 'c']);
    snapshot.updateChanges();
    expect(positionsWithType(snapshot, ChangeType.removed)).toEqual([1]);

    snapshot.trackers.replaceBlock(1, 0, ['b']);
    snapshot.content.updateState(['a', 'b', 'c']);
    snapshot.updateChanges();

    // The original line is back and the snapshot reports no pending changes.
    expect(snapshot.content.getChangesLinesCount()).toBe(0);
    expect(snapshot.content.getLastStateLines()).toEqual(['a', 'b', 'c']);
  });

  it('keeps later edits intact and correctly positioned when an earlier block is reverted', () => {
    const snapshot = new FileSnapshot('a\nb\nc\nd');

    // Insert a block early and edit a later line, then revert only the insertion.
    snapshot.trackers.restoreOrAddTracker(1)?.change('INS');
    snapshot.content.updateState(['a', 'INS', 'b', 'c', 'd']);
    snapshot.trackers.findCurrentLine(4)?.change('D');
    snapshot.content.updateState(['a', 'INS', 'b', 'c', 'D']);
    snapshot.updateChanges();
    expect(positionsWithType(snapshot, ChangeType.added)).toEqual([1]);
    expect(positionsWithType(snapshot, ChangeType.changed)).toEqual([4]);

    // Revert the insertion at position 1; the later edit must shift to line 3.
    snapshot.trackers.replaceBlock(1, 1, []);
    snapshot.content.updateState(['a', 'b', 'c', 'D']);
    snapshot.updateChanges();

    expect(positionsWithType(snapshot, ChangeType.added)).toEqual([]);
    expect(positionsWithType(snapshot, ChangeType.changed)).toEqual([3]);
    expect(snapshot.trackers.findCurrentLine(3)?.current).toBe('D');
  });

  /**
   * Regression guards for the boundary-pairing blindness of the counts-differ
   * branch: a replacement line whose content matches a doomed original's
   * baseline must fold back onto that tracker. Dooming it and re-adding the
   * same content anchored the original as removed and brought its own text
   * back as a phantom added line, so reverting a mid-line split or join to the
   * exact baseline still showed added/removed markers.
   */
  it('reverting a mid-line split back to the baseline leaves no markers', () => {
    const snapshot = new FileSnapshot('x\nhello world\ny');

    // The change detector records a mid-line split as changed + added.
    snapshot.trackers.restoreOrAddTracker(2, true, 'world')?.change('world');
    snapshot.trackers.findCurrentLine(1)?.change('hello');
    snapshot.content.updateState(['x', 'hello', 'world', 'y']);
    snapshot.updateChanges();
    expect(positionsWithType(snapshot, ChangeType.changed)).toEqual([1]);
    expect(positionsWithType(snapshot, ChangeType.added)).toEqual([2]);

    // Revert the hunk: replace the 2-line block with the baseline line.
    snapshot.trackers.replaceBlock(1, 2, ['hello world']);
    snapshot.content.updateState(['x', 'hello world', 'y']);
    snapshot.updateChanges();

    expect(positionsWithType(snapshot, ChangeType.added)).toEqual([]);
    expect(positionsWithType(snapshot, ChangeType.removed)).toEqual([]);
    expect(positionsWithType(snapshot, ChangeType.changed)).toEqual([]);
    expect(snapshot.trackers.findCurrentLine(2)?.current).toBe('y');
  });

  it('reverting a mid-line join back to the baseline leaves no markers', () => {
    const snapshot = new FileSnapshot('x\nhello\nworld\ny');

    // The change detector records a join as changed + a removed anchor.
    snapshot.trackers.findCurrentLine(1)?.change('hello world');
    snapshot.trackers.removeTrackerOrLine(2);
    snapshot.content.updateState(['x', 'hello world', 'y']);
    snapshot.updateChanges();
    expect(positionsWithType(snapshot, ChangeType.changed)).toEqual([1]);
    expect(positionsWithType(snapshot, ChangeType.removed)).toEqual([2]);

    // Revert the hunk: replace the joined line with the two baseline lines.
    snapshot.trackers.replaceBlock(1, 1, ['hello', 'world']);
    snapshot.content.updateState(['x', 'hello', 'world', 'y']);
    snapshot.updateChanges();

    expect(positionsWithType(snapshot, ChangeType.added)).toEqual([]);
    expect(positionsWithType(snapshot, ChangeType.removed)).toEqual([]);
    expect(positionsWithType(snapshot, ChangeType.changed)).toEqual([]);
    expect(snapshot.trackers.findCurrentLine(3)?.current).toBe('y');
  });

  /**
   * Anchor-placement guards for blocks that reach the document end: the
   * counts-differ pass removes unpaired lines first, and clamping against the
   * temporarily shrunken document used to pin anchors above the block (nothing
   * ever lifts an anchor back up). The clamp is deferred to the final pass, so
   * anchors settle on the conventional "removed below here" line.
   */
  it('keeps the anchors of an EOF block shrink on the replacement line', () => {
    const snapshot = new FileSnapshot('a\nb\nc');

    snapshot.trackers.replaceBlock(1, 2, ['X']);
    snapshot.content.updateState(['a', 'X']);
    snapshot.updateChanges();

    expect(positionsWithType(snapshot, ChangeType.removed)).toEqual([1]);
  });

  it('keeps the doomed anchor of an EOF block grow at the last real line', () => {
    const snapshot = new FileSnapshot('a\nb\nc');

    snapshot.trackers.replaceBlock(1, 2, ['b', 'X', 'Y']);
    snapshot.content.updateState(['a', 'b', 'X', 'Y']);
    snapshot.updateChanges();

    expect(positionsWithType(snapshot, ChangeType.removed)).toEqual([3]);
  });

  it('does not drag a pre-existing anchor above an EOF block being grown', () => {
    const snapshot = new FileSnapshot('a\nb\nc');

    snapshot.trackers.removeTrackerOrLine(2);
    snapshot.content.updateState(['a', 'b']);
    snapshot.updateChanges();
    expect(positionsWithType(snapshot, ChangeType.removed)).toEqual([1]);

    snapshot.trackers.replaceBlock(1, 1, ['P', 'Q']);
    snapshot.content.updateState(['a', 'P', 'Q']);
    snapshot.updateChanges();

    expect(positionsWithType(snapshot, ChangeType.removed)).toEqual([2]);
  });

  it('converges an EOF replace-then-revert roundtrip back to a clean state', () => {
    const snapshot = new FileSnapshot('a\nb');

    snapshot.trackers.replaceBlock(1, 1, ['P', 'Q']);
    snapshot.content.updateState(['a', 'P', 'Q']);
    snapshot.updateChanges();

    snapshot.trackers.replaceBlock(1, 2, ['b']);
    snapshot.content.updateState(['a', 'b']);
    snapshot.updateChanges();

    expect(positionsWithType(snapshot, ChangeType.added)).toEqual([]);
    expect(positionsWithType(snapshot, ChangeType.removed)).toEqual([]);
    expect(positionsWithType(snapshot, ChangeType.changed)).toEqual([]);
  });

  it('keeps a surviving original positioned after unpaired inserts and removals around it', () => {
    const snapshot = new FileSnapshot('a\nb\nt');

    // Replace the block (a, b) with (N, b, M): "b" must survive in place.
    snapshot.trackers.replaceBlock(0, 2, ['N', 'b', 'M']);
    snapshot.content.updateState(['N', 'b', 'M', 't']);
    snapshot.updateChanges();

    expect(snapshot.trackers.findCurrentLine(0)?.current).toBe('N');
    expect(snapshot.trackers.findCurrentLine(1)?.isStateOriginal()).toBe(true);
    expect(snapshot.trackers.findCurrentLine(2)?.current).toBe('M');
    expect(snapshot.trackers.findCurrentLine(3)?.current).toBe('t');
    expect(positionsWithType(snapshot, ChangeType.changed)).toEqual([]);
  });

  it('places every replacement on its expected current position when the block straddles tracked and removed lines', () => {
    // Start from a, b, c, d, e; remove the middle line b so the tracker holds
    // a removed marker at removedAtPosition=1 alongside a@0, c@1, d@2, e@3.
    const snapshot = new FileSnapshot('a\nb\nc\nd\ne');

    snapshot.trackers.removeTrackerOrLine(1);
    snapshot.content.updateState(['a', 'c', 'd', 'e']);
    snapshot.updateChanges();
    expect(positionsWithType(snapshot, ChangeType.removed)).toEqual([1]);

    // Replace the leading block (a, c) with three lines so the new block
    // straddles the removed marker at position 1: removeCount=2, newLines.length=3.
    snapshot.trackers.replaceBlock(0, 2, ['X', 'Y', 'Z']);
    snapshot.content.updateState(['X', 'Y', 'Z', 'd', 'e']);
    snapshot.updateChanges();

    // Every replacement line lands on its expected current position and the
    // trailing tracked lines slide by the net offset (+1) without drift.
    expect(snapshot.trackers.findCurrentLine(0)?.current).toBe('X');
    expect(snapshot.trackers.findCurrentLine(1)?.current).toBe('Y');
    expect(snapshot.trackers.findCurrentLine(2)?.current).toBe('Z');
    expect(snapshot.trackers.findCurrentLine(3)?.current).toBe('d');
    expect(snapshot.trackers.findCurrentLine(4)?.current).toBe('e');
    expect(snapshot.trackers.findCurrentLine(5)).toBeNull();

    // The cached current-position index matches a direct tracker scan, so the
    // straddle did not desynchronize the index from the underlying tracker.
    for (let pos = -1; pos <= 6; pos++) {
      expect(snapshot.trackers.findCurrentLine(pos)).toBe(liveAt(snapshot, pos));
    }

    // The new live document holds exactly five lines: no doomed-or-restored
    // ghost stays on a current position past the visible end.
    expect(snapshot.content.getLastStateLines()).toEqual(['X', 'Y', 'Z', 'd', 'e']);
  });

  /**
   * Identity of a content-matched resurrection is content-first (pinned
   * policy): when the counts-differ pass re-inserts a line whose content
   * matches a just-doomed sibling's deletion-time content, the resurrection
   * follows the content, not the baseline order. Two edits re-inserted in
   * swapped order therefore adopt each other's baseline identity. The markers
   * stay correct; the crossing is intentional and locked here so a future
   * switch to order-preservation trips this guard.
   */
  it('resurrects a content-matched anchor by content, not by baseline order', () => {
    const snapshot = new FileSnapshot('b\nk');

    // Edit both lines, then replace the block with the two edits in swapped
    // order plus a fresh line: 'w' and 'v' each match a doomed line's
    // deletion-time content, so both fold back; 'z' is a new added line.
    snapshot.trackers.findCurrentLine(0)?.change('v');
    snapshot.trackers.findCurrentLine(1)?.change('w');
    snapshot.content.updateState(['v', 'w']);
    snapshot.updateChanges();

    snapshot.trackers.replaceBlock(0, 2, ['w', 'v', 'z']);
    snapshot.content.updateState(['w', 'v', 'z']);
    snapshot.updateChanges();

    // Markers are correct either way: the two folds read as changed, the fresh
    // line as added, nothing left removed.
    expect(positionsWithType(snapshot, ChangeType.changed)).toEqual([0, 1]);
    expect(positionsWithType(snapshot, ChangeType.added)).toEqual([2]);
    expect(positionsWithType(snapshot, ChangeType.removed)).toEqual([]);

    // Content-first identity: line 0 ('w') resurrects the tracker that last
    // held 'w' (baseline position 1), line 1 ('v') the one that last held 'v'
    // (baseline position 0). The survivors' baseline order is inverted, and
    // that crossing is the pinned, intended policy.
    expect(snapshot.trackers.findCurrentLine(0)?.current).toBe('w');
    expect(snapshot.trackers.findCurrentLine(0)?.originalPosition).toBe(1);
    expect(snapshot.trackers.findCurrentLine(1)?.current).toBe('v');
    expect(snapshot.trackers.findCurrentLine(1)?.originalPosition).toBe(0);
    expect(snapshot.trackers.findCurrentLine(2)?.originalPosition).toBe(-1);
  });
});

describe('FileSnapshot.getChangedPositions (navigation source)', () => {
  it('returns no positions for a pristine snapshot', () => {
    const snapshot = new FileSnapshot('a\nb\nc');

    expect(snapshot.content.getChangedPositions()).toEqual([]);
  });

  it('collects changed, added and removed positions in ascending order', () => {
    const snapshot = new FileSnapshot('a\nb\nc\nd\ne');

    // Change line 0, change line 3, and remove line 1 (which leaves a removed
    // marker at position 1 and shifts the lines below it up).
    snapshot.trackers.findCurrentLine(0)?.change('A');
    snapshot.trackers.findCurrentLine(3)?.change('D');
    snapshot.trackers.removeTrackerOrLine(1);
    snapshot.content.updateState(['A', 'c', 'D', 'e']);
    snapshot.updateChanges();

    // Navigation offers exactly the highlighted lines: line 0 changed, line 1
    // (the removal marker), line 2 changed. The same set the decorations draw,
    // ascending, with no entry for the untouched trailing line.
    expect(snapshot.content.getChangedPositions()).toEqual([0, 1, 2]);
    expect(positionsWithType(snapshot, ChangeType.changed)).toEqual([0, 2]);
    expect(positionsWithType(snapshot, ChangeType.removed)).toEqual([1]);
  });

  it('reflects the current state and includes restored lines like the highlights', () => {
    const snapshot = new FileSnapshot('a\nb\nc');

    snapshot.trackers.findCurrentLine(0)?.change('A');
    snapshot.trackers.findCurrentLine(2)?.change('C');
    snapshot.updateChanges();
    expect(snapshot.content.getChangedPositions()).toEqual([0, 2]);

    // Edit line 0 back to its original: it becomes a restored line, which is
    // still highlighted, so navigation keeps offering it. Line 2 stays changed.
    snapshot.trackers.findCurrentLine(0)?.change('a');
    snapshot.updateChanges();

    expect(snapshot.content.getChangedPositions()).toEqual([0, 2]);
    expect(positionsWithType(snapshot, ChangeType.restored)).toEqual([0]);
    expect(positionsWithType(snapshot, ChangeType.changed)).toEqual([2]);
  });

  it('can scope navigation to a subset of change types', () => {
    const snapshot = new FileSnapshot('a\nb\nc');

    // One restored line (0) and one changed line (2).
    snapshot.trackers.findCurrentLine(0)?.change('A');
    snapshot.trackers.findCurrentLine(0)?.change('a');
    snapshot.trackers.findCurrentLine(2)?.change('C');
    snapshot.updateChanges();

    // Restricting to "changed" drops the restored line from the navigation set.
    expect(snapshot.content.getChangedPositions(ChangeType.changed)).toEqual([2]);
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
    const payload = SnapshotCodec.encode(snapshot);

    expect(Object.prototype.hasOwnProperty.call(payload, 'deletedTimestamp')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(payload, 'movedIntoAt')).toBe(false);
  });

  it('serializes deletedTimestamp on a tombstone and omits movedIntoAt when unset', () => {
    const snapshot = new FileSnapshot('a\nb');

    snapshot.deletedTimestamp = 123456;

    const payload = SnapshotCodec.encode(snapshot);

    expect(payload.deletedTimestamp).toBe(123456);
    expect(Object.prototype.hasOwnProperty.call(payload, 'movedIntoAt')).toBe(false);
  });

  it('round-trips deletedTimestamp through fromJSON losslessly', () => {
    const original = new FileSnapshot('a\nb');

    original.deletedTimestamp = 999;

    const restored = SnapshotCodec.decode(SnapshotCodec.encode(original));

    expect(restored.deletedTimestamp).toBe(999);
    expect(restored.isTombstone()).toBe(true);
    expect(restored.movedIntoAt).toBeUndefined();
    expect(restored.isMovedIn()).toBe(false);
  });

  it('round-trips movedIntoAt through fromJSON losslessly', () => {
    const original = new FileSnapshot('x');

    original.movedIntoAt = 555;

    const restored = SnapshotCodec.decode(SnapshotCodec.encode(original));

    expect(restored.movedIntoAt).toBe(555);
    expect(restored.isMovedIn()).toBe(true);
    expect(restored.deletedTimestamp).toBeUndefined();
    expect(restored.isTombstone()).toBe(false);
  });

  it('round-trips both markers together through fromJSON', () => {
    const original = new FileSnapshot('x\ny');

    original.deletedTimestamp = 1;
    original.movedIntoAt = 2;

    const restored = SnapshotCodec.decode(SnapshotCodec.encode(original));

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

    const restored = SnapshotCodec.decode(payload);

    expect(restored.isTombstone()).toBe(true);
    expect(restored.isMovedIn()).toBe(true);
    expect(restored.deletedTimestamp).toBe(200);
    expect(restored.movedIntoAt).toBe(150);
  });
});
