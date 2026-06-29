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
    .content.getChanges(type)
    .simplify()
    .map((change): number => change.getLine())
    .sort((a: number, b: number): number => a - b);

describe('FileSnapshot serialize/deserialize round-trip', () => {
  it('preserves a clean snapshot baseline and state', () => {
    const snapshot = new FileSnapshot('a\nb\nc', '\n', makeFile('a.md'));
    const restored = FileSnapshot.fromJSON(snapshot.toJSON(), makeFile('a.md'));

    expect(restored.content.getOriginalStateLines()).toEqual(['a', 'b', 'c']);
    expect(restored.content.getLastStateLines()).toEqual(['a', 'b', 'c']);
    expect(restored.content.getChangesLinesCount()).toBe(0);
    expect(restored.content.lineBreak).toBe('\n');
  });

  it('restores a changed line as changed', () => {
    const snapshot = new FileSnapshot('a\nb\nc');

    snapshot.trackers.findCurrentLine(1)?.change('B');
    snapshot.content.updateState(['a', 'B', 'c']);
    snapshot.updateChanges();

    const restored = FileSnapshot.fromJSON(snapshot.toJSON());

    expect(positionsWithType(restored, ChangeType.changed)).toEqual([1]);
    expect(restored.content.getChangesLinesCount()).toBe(1);
    expect(restored.content.getLastStateLines()).toEqual(['a', 'B', 'c']);
  });

  it('restores added and removed lines with their positions', () => {
    const snapshot = new FileSnapshot('a\nb\nc');

    // Remove the original middle line and add a brand new tail line.
    snapshot.trackers.removeTrackerOrLine(1);
    const added: TrackerLine = snapshot.trackers.restoreOrAddTracker(2, false);
    added.change('d');
    snapshot.content.updateState(['a', 'c', 'd']);
    snapshot.updateChanges();

    const before = {
      added: positionsWithType(snapshot, ChangeType.added),
      removed: positionsWithType(snapshot, ChangeType.removed),
    };

    const restored = FileSnapshot.fromJSON(snapshot.toJSON());

    expect(positionsWithType(restored, ChangeType.added)).toEqual(before.added);
    expect(positionsWithType(restored, ChangeType.removed)).toEqual(before.removed);
    expect(restored.content.getLastStateLines()).toEqual(['a', 'c', 'd']);
  });

  it('keeps findCurrentLine working after restore (index rebuilt)', () => {
    const snapshot = new FileSnapshot('a\nb\nc');
    snapshot.trackers.findCurrentLine(2)?.change('C');
    snapshot.content.updateState(['a', 'b', 'C']);
    snapshot.updateChanges();

    const restored = FileSnapshot.fromJSON(snapshot.toJSON());

    expect(restored.trackers.findCurrentLine(0)?.current).toBe('a');
    expect(restored.trackers.findCurrentLine(2)?.current).toBe('C');
    expect(restored.trackers.findCurrentLine(99)).toBeNull();
  });

  it('assigns fresh, unique ids to restored tracker lines', () => {
    const snapshot = new FileSnapshot('a\nb\nc');
    const restored = FileSnapshot.fromJSON(snapshot.toJSON());

    const ids: string[] = restored.trackers.getTrackerLines().map((line: TrackerLine): string => line.id);

    // No empty ids and no duplicates across the restored tracker.
    expect(ids.every((id: string): boolean => typeof id === 'string' && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);

    // Restored ids are independent objects from the source tracker.
    const sourceIds: Set<string> = new Set(snapshot.trackers.getTrackerLines().map((line: TrackerLine): string => line.id));
    expect(ids.some((id: string): boolean => sourceIds.has(id))).toBe(false);
  });

  it('round-trips a custom line break', () => {
    const snapshot = new FileSnapshot('a\r\nb', '\r\n', makeFile('crlf.md'));
    snapshot.trackers.findCurrentLine(0)?.change('A');
    snapshot.content.updateState(['A', 'b']);
    snapshot.updateChanges();

    const restored = FileSnapshot.fromJSON(snapshot.toJSON());

    expect(restored.content.lineBreak).toBe('\r\n');
    expect(restored.content.getLastState()).toBe('A\r\nb');
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
    expect(restored.content.getOriginalStateLines()).toEqual(['']);
    expect(restored.content.getLastStateLines()).toEqual(['a']);
    expect(restored.trackers.getTrackerLines()).toEqual([]);
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

    expect(restored.trackers.getTrackerLines()).toEqual([]);
    expect(restored.content.getOriginalStateLines()).toEqual(['a', 'b']);
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

    expect(restored.content.lineBreak).toBe('\n');
    expect(restored.content.getLastState()).toBe('a\nb');
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

    expect(snapshot.content.getOriginalStateLines()).toEqual(['a', 'b', 'c']);
    expect(snapshot.content.getHistoryOriginalStateLines()).toEqual(['a', 'b', 'c']);
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

    snapshot.trackers.findCurrentLine(1)?.change('M2');
    snapshot.content.updateState(['m1', 'M2', 'm3']);
    snapshot.updateChanges();

    const before: number = snapshot.content.getChangesLinesCount();

    snapshot.adoptHistory(['h1', 'h2'], []);

    // The marker baseline, tracker, state, and change count are untouched.
    expect(snapshot.content.getOriginalStateLines()).toEqual(['m1', 'm2', 'm3']);
    expect(snapshot.content.getLastStateLines()).toEqual(['m1', 'M2', 'm3']);
    expect(snapshot.content.getChangesLinesCount()).toBe(before);

    // Only the history baseline moved.
    expect(snapshot.content.getHistoryOriginalStateLines()).toEqual(['h1', 'h2']);
  });
});

describe('FileSnapshot.resetMarkerBaseline - eager session re-baseline at restore', () => {
  it('clears a restored snapshot change count without touching the history baseline', () => {
    const snapshot = new FileSnapshot('a\nb\nc');

    snapshot.trackers.findCurrentLine(1)?.change('B');
    snapshot.content.updateState(['a', 'B', 'c']);
    snapshot.updateChanges();

    const restored = FileSnapshot.fromJSON(snapshot.toJSON());

    // The restored snapshot still reports its full history diff before re-baseline.
    expect(restored.content.getChangesLinesCount()).toBe(1);

    restored.resetMarkerBaseline();

    // After re-baseline the snapshot is session-clean: no marker-baseline diff,
    // so the tree/tab decorator paints nothing for it on a fresh launch.
    expect(restored.content.getChangesLinesCount()).toBe(0);
    // The marker baseline now equals the current state.
    expect(restored.content.getOriginalStateLines()).toEqual(['a', 'B', 'c']);
    expect(restored.content.getLastStateLines()).toEqual(['a', 'B', 'c']);
    // The HISTORY baseline (the persisted original) is untouched, so the modal
    // still diffs against it.
    expect(restored.content.getHistoryOriginalStateLines()).toEqual(['a', 'b', 'c']);
  });

  it('registers a subsequent session edit as a change after re-baseline', () => {
    const snapshot = new FileSnapshot('a\nb\nc');

    snapshot.trackers.findCurrentLine(1)?.change('B');
    snapshot.content.updateState(['a', 'B', 'c']);
    snapshot.updateChanges();

    const restored = FileSnapshot.fromJSON(snapshot.toJSON());

    restored.resetMarkerBaseline();
    expect(restored.content.getChangesLinesCount()).toBe(0);

    // A genuine edit this session is measured against the re-baselined origin.
    restored.trackers.findCurrentLine(0)?.change('A');
    restored.content.updateState(['A', 'B', 'c']);
    restored.updateChanges();

    expect(restored.content.getChangesLinesCount()).toBe(1);
  });
});
