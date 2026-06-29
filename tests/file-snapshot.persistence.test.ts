import { describe, expect, it } from '@jest/globals';
import { ChangeType } from '@/consts';
import { FileSnapshot } from '@/snapshots/file.snapshot';
import { TrackerLine } from '@/lines/tracker.line';
import type { SerializedFileSnapshot, SerializedTrackerLine } from '@/types';

import { makeFile } from './helpers/builders';

/**
 * Round-trip tests for FileSnapshot persistence. They drive the snapshot
 * through real edits, serialize it, rebuild it from the serialized form, and
 * assert the reconstructed snapshot reports the same change state. They also
 * pin the contract that restored tracker ids are fresh and collision-free.
 */

const positionsWithType = (snapshot: FileSnapshot, type: ChangeType): number[] =>
  snapshot
    .getChanges(type)
    .simplify()
    .map((change): number => change.getLine())
    .sort((a: number, b: number): number => a - b);

describe('FileSnapshot serialize/deserialize round-trip', () => {
  it('preserves a clean snapshot baseline and state', () => {
    const snapshot = new FileSnapshot('a\nb\nc', '\n', makeFile('a.md'));
    const restored = FileSnapshot.fromJSON(snapshot.toJSON(), makeFile('a.md'));

    expect(restored.getOriginalStateLines()).toEqual(['a', 'b', 'c']);
    expect(restored.getLastStateLines()).toEqual(['a', 'b', 'c']);
    expect(restored.getChangesLinesCount()).toBe(0);
    expect(restored.lineBreak).toBe('\n');
  });

  it('restores a changed line as changed', () => {
    const snapshot = new FileSnapshot('a\nb\nc');

    snapshot.findCurrentLine(1)?.change('B');
    snapshot.updateState(['a', 'B', 'c']);
    snapshot.updateChanges();

    const restored = FileSnapshot.fromJSON(snapshot.toJSON());

    expect(positionsWithType(restored, ChangeType.changed)).toEqual([1]);
    expect(restored.getChangesLinesCount()).toBe(1);
    expect(restored.getLastStateLines()).toEqual(['a', 'B', 'c']);
  });

  it('restores added and removed lines with their positions', () => {
    const snapshot = new FileSnapshot('a\nb\nc');

    // Remove the original middle line and add a brand new tail line.
    snapshot.removeTrackerOrLine(1);
    const added: TrackerLine = snapshot.restoreOrAddTracker(2, false);
    added.change('d');
    snapshot.updateState(['a', 'c', 'd']);
    snapshot.updateChanges();

    const before = {
      added: positionsWithType(snapshot, ChangeType.added),
      removed: positionsWithType(snapshot, ChangeType.removed),
    };

    const restored = FileSnapshot.fromJSON(snapshot.toJSON());

    expect(positionsWithType(restored, ChangeType.added)).toEqual(before.added);
    expect(positionsWithType(restored, ChangeType.removed)).toEqual(before.removed);
    expect(restored.getLastStateLines()).toEqual(['a', 'c', 'd']);
  });

  it('keeps findCurrentLine working after restore (index rebuilt)', () => {
    const snapshot = new FileSnapshot('a\nb\nc');
    snapshot.findCurrentLine(2)?.change('C');
    snapshot.updateState(['a', 'b', 'C']);
    snapshot.updateChanges();

    const restored = FileSnapshot.fromJSON(snapshot.toJSON());

    expect(restored.findCurrentLine(0)?.current).toBe('a');
    expect(restored.findCurrentLine(2)?.current).toBe('C');
    expect(restored.findCurrentLine(99)).toBeNull();
  });

  it('assigns fresh, unique ids to restored tracker lines', () => {
    const snapshot = new FileSnapshot('a\nb\nc');
    const restored = FileSnapshot.fromJSON(snapshot.toJSON());

    const ids: string[] = restored.getTrackerLines().map((line: TrackerLine): string => line.id);

    // No empty ids and no duplicates across the restored tracker.
    expect(ids.every((id: string): boolean => typeof id === 'string' && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);

    // Restored ids are independent objects from the source tracker.
    const sourceIds: Set<string> = new Set(snapshot.getTrackerLines().map((line: TrackerLine): string => line.id));
    expect(ids.some((id: string): boolean => sourceIds.has(id))).toBe(false);
  });

  it('round-trips a custom line break', () => {
    const snapshot = new FileSnapshot('a\r\nb', '\r\n', makeFile('crlf.md'));
    snapshot.findCurrentLine(0)?.change('A');
    snapshot.updateState(['A', 'b']);
    snapshot.updateChanges();

    const restored = FileSnapshot.fromJSON(snapshot.toJSON());

    expect(restored.lineBreak).toBe('\r\n');
    expect(restored.getLastState()).toBe('A\r\nb');
    expect(positionsWithType(restored, ChangeType.changed)).toEqual([0]);
  });

  it('toJSON records the file path and omits tracker ids', () => {
    const snapshot = new FileSnapshot('a\nb', '\n', makeFile('notes/x.md'));
    const json = snapshot.toJSON();

    expect(json.path).toBe('notes/x.md');
    expect(json.tracker).toHaveLength(2);
    expect(json.tracker[0]).not.toHaveProperty('id');
  });
});

describe('FileSnapshot.fromJSON malformed-input guards', () => {
  it('returns an empty-lines snapshot when `lines` is absent', () => {
    const data = {
      path: 'a.md',
      lineBreak: '\n',
      timestamp: 123,
      state: ['a'],
      tracker: [],
      versions: [],
    } as unknown as SerializedFileSnapshot;

    const restored = FileSnapshot.fromJSON(data);

    // An absent `lines` falls back to []; the constructor's split of "" yields
    // [""] (the same shape an empty file produces), which is the safe default.
    expect(restored.getOriginalStateLines()).toEqual(['']);
    expect(restored.getLastStateLines()).toEqual(['a']);
    expect(restored.getTrackerLines()).toEqual([]);
  });

  it('returns an empty-tracker snapshot when `tracker` is absent', () => {
    const data = {
      path: 'a.md',
      lineBreak: '\n',
      timestamp: 123,
      lines: ['a', 'b'],
      state: ['a', 'b'],
      versions: [],
    } as unknown as SerializedFileSnapshot;

    const restored = FileSnapshot.fromJSON(data);

    expect(restored.getTrackerLines()).toEqual([]);
    expect(restored.getOriginalStateLines()).toEqual(['a', 'b']);
  });

  it('defaults `lineBreak` to "\\n" when not a string', () => {
    const data = {
      path: 'a.md',
      timestamp: 0,
      lines: ['a', 'b'],
      state: ['a', 'b'],
      tracker: [],
      versions: [],
    } as unknown as SerializedFileSnapshot;

    const restored = FileSnapshot.fromJSON(data);

    expect(restored.lineBreak).toBe('\n');
    expect(restored.getLastState()).toBe('a\nb');
  });

  it('coerces a non-numeric `currentPosition` in TrackerLine.fromJSON to the safe default', () => {
    const data = {
      originalPosition: 0,
      currentPosition: 'boom',
      removedAtPosition: -1,
      changeAtPosition: -1,
      contentSameOriginal: true,
      hash: null,
      original: null,
      current: null,
      removedTimeStamp: -1,
      changedTimeStamp: -1,
      addedTimeStamp: 1,
    } as unknown as SerializedTrackerLine;

    const restored: TrackerLine = TrackerLine.fromJSON(data);

    expect(restored.currentPosition).toBe(-1);
    expect(typeof restored.currentPosition).toBe('number');
  });
});

describe('FileSnapshot marker/history baseline split', () => {
  it('defaults the history baseline to the marker baseline on capture', () => {
    const snapshot = new FileSnapshot('a\nb\nc');

    expect(snapshot.getOriginalStateLines()).toEqual(['a', 'b', 'c']);
    expect(snapshot.getHistoryOriginalStateLines()).toEqual(['a', 'b', 'c']);
  });

  it('persists the history baseline (not the marker baseline) in toJSON', () => {
    const snapshot = new FileSnapshot('m1\nm2', '\n', makeFile('a.md'));

    snapshot.adoptHistory(['h1', 'h2', 'h3'], []);

    // The on-disk lines carry the history baseline so the modal can diff against
    // the persisted original after a restart; the session marker baseline is not
    // persisted.
    expect(snapshot.toJSON().lines).toEqual(['h1', 'h2', 'h3']);
  });

  it('adoptHistory overrides only the history baseline and versions', () => {
    const snapshot = new FileSnapshot('m1\nm2\nm3');

    snapshot.findCurrentLine(1)?.change('M2');
    snapshot.updateState(['m1', 'M2', 'm3']);
    snapshot.updateChanges();

    const before: number = snapshot.getChangesLinesCount();

    snapshot.adoptHistory(['h1', 'h2'], []);

    // The marker baseline, tracker, state, and change count are untouched.
    expect(snapshot.getOriginalStateLines()).toEqual(['m1', 'm2', 'm3']);
    expect(snapshot.getLastStateLines()).toEqual(['m1', 'M2', 'm3']);
    expect(snapshot.getChangesLinesCount()).toBe(before);

    // Only the history baseline moved.
    expect(snapshot.getHistoryOriginalStateLines()).toEqual(['h1', 'h2']);
  });
});

describe('FileSnapshot.resetMarkerBaseline - eager session re-baseline at restore', () => {
  it('clears a restored snapshot change count without touching the history baseline', () => {
    const snapshot = new FileSnapshot('a\nb\nc');

    snapshot.findCurrentLine(1)?.change('B');
    snapshot.updateState(['a', 'B', 'c']);
    snapshot.updateChanges();

    const restored = FileSnapshot.fromJSON(snapshot.toJSON());

    // The restored snapshot still reports its full history diff before re-baseline.
    expect(restored.getChangesLinesCount()).toBe(1);

    restored.resetMarkerBaseline();

    // After re-baseline the snapshot is session-clean: no marker-baseline diff,
    // so the tree/tab decorator paints nothing for it on a fresh launch.
    expect(restored.getChangesLinesCount()).toBe(0);
    // The marker baseline now equals the current state.
    expect(restored.getOriginalStateLines()).toEqual(['a', 'B', 'c']);
    expect(restored.getLastStateLines()).toEqual(['a', 'B', 'c']);
    // The HISTORY baseline (the persisted original) is untouched, so the modal
    // still diffs against it.
    expect(restored.getHistoryOriginalStateLines()).toEqual(['a', 'b', 'c']);
  });

  it('registers a subsequent session edit as a change after re-baseline', () => {
    const snapshot = new FileSnapshot('a\nb\nc');

    snapshot.findCurrentLine(1)?.change('B');
    snapshot.updateState(['a', 'B', 'c']);
    snapshot.updateChanges();

    const restored = FileSnapshot.fromJSON(snapshot.toJSON());

    restored.resetMarkerBaseline();
    expect(restored.getChangesLinesCount()).toBe(0);

    // A genuine edit this session is measured against the re-baselined origin.
    restored.findCurrentLine(0)?.change('A');
    restored.updateState(['A', 'B', 'c']);
    restored.updateChanges();

    expect(restored.getChangesLinesCount()).toBe(1);
  });
});
