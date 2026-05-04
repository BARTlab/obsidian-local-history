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
