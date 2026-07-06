import { describe, expect, it } from 'vitest';
import { ChangeType, KeepHistory } from '@/consts';
import * as HunkHelper from '@/helpers/hunk.helper';
import { resolveOrigin } from '@/helpers/origin.helper';
import { FileSnapshot } from '@/snapshots/file.snapshot';
import { SnapshotCodec } from '@/snapshots/snapshot-codec';
import { TrackerLine } from '@/lines/tracker.line';
import type { SerializedFileSnapshot, SerializedTrackerLine, SnapshotCaptureOptions } from '@/types';

import { makeFile } from './helpers/builders';

/** Every capture cadence gate open so a forced capture always lands a version. */
const captureOptions = (overrides: Partial<SnapshotCaptureOptions> = {}): SnapshotCaptureOptions => ({
  enabled: true,
  intervalMs: 0,
  editThreshold: 0,
  maxVersions: 0,
  maxVersionAgeDays: 0,
  ...overrides,
});

/**
 * The new-side positions a diff touches: for every hunk, each of its current-side
 * lines. Mirrors what the change map records for a pure modification, so a seeded
 * change map can be asserted equal to a direct HunkHelper.diff of origin vs current.
 */
const diffPositions = (origin: string[], current: string[]): number[] =>
  HunkHelper.diff(origin, current, '\n')
    .flatMap((hunk): number[] =>
      Array.from({ length: hunk.newLines }, (_unused, offset): number => hunk.newStart - 1 + offset));

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
    const restored = SnapshotCodec.decode(SnapshotCodec.encode(snapshot), makeFile('a.md'));

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

    const restored = SnapshotCodec.decode(SnapshotCodec.encode(snapshot));

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

    const restored = SnapshotCodec.decode(SnapshotCodec.encode(snapshot));

    expect(positionsWithType(restored, ChangeType.added)).toEqual(before.added);
    expect(positionsWithType(restored, ChangeType.removed)).toEqual(before.removed);
    expect(restored.content.getLastStateLines()).toEqual(['a', 'c', 'd']);
  });

  it('keeps findCurrentLine working after restore (index rebuilt)', () => {
    const snapshot = new FileSnapshot('a\nb\nc');
    snapshot.trackers.findCurrentLine(2)?.change('C');
    snapshot.content.updateState(['a', 'b', 'C']);
    snapshot.updateChanges();

    const restored = SnapshotCodec.decode(SnapshotCodec.encode(snapshot));

    expect(restored.trackers.findCurrentLine(0)?.current).toBe('a');
    expect(restored.trackers.findCurrentLine(2)?.current).toBe('C');
    expect(restored.trackers.findCurrentLine(99)).toBeNull();
  });

  it('assigns fresh, unique ids to restored tracker lines', () => {
    const snapshot = new FileSnapshot('a\nb\nc');
    const restored = SnapshotCodec.decode(SnapshotCodec.encode(snapshot));

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

    const restored = SnapshotCodec.decode(SnapshotCodec.encode(snapshot));

    expect(restored.content.lineBreak).toBe('\r\n');
    expect(restored.content.getLastState()).toBe('A\r\nb');
    expect(positionsWithType(restored, ChangeType.changed)).toEqual([0]);
  });

  it('toJSON records the file path and omits tracker ids', () => {
    const snapshot = new FileSnapshot('a\nb', '\n', makeFile('notes/x.md'));
    const json = SnapshotCodec.encode(snapshot);

    expect(json.path).toBe('notes/x.md');
    expect(json.tracker).toHaveLength(2);
    expect(json.tracker[0]).not.toHaveProperty('id');
  });
});

describe('SnapshotCodec.decode malformed-input guards', () => {
  it('returns an empty-lines snapshot when `lines` is absent', () => {
    const data = {
      path: 'a.md',
      lineBreak: '\n',
      timestamp: 123,
      state: ['a'],
      tracker: [],
      versions: [],
    } as unknown as SerializedFileSnapshot;

    const restored = SnapshotCodec.decode(data);

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

    const restored = SnapshotCodec.decode(data);

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

    const restored = SnapshotCodec.decode(data);

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
    expect(SnapshotCodec.encode(snapshot).lines).toEqual(['h1', 'h2', 'h3']);
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

    const restored = SnapshotCodec.decode(SnapshotCodec.encode(snapshot));

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

    const restored = SnapshotCodec.decode(SnapshotCodec.encode(snapshot));

    restored.resetMarkerBaseline();
    expect(restored.content.getChangesLinesCount()).toBe(0);

    // A genuine edit this session is measured against the re-baselined origin.
    restored.trackers.findCurrentLine(0)?.change('A');
    restored.content.updateState(['A', 'B', 'c']);
    restored.updateChanges();

    expect(restored.content.getChangesLinesCount()).toBe(1);
  });
});

describe('FileSnapshot.seedTrackerFromOrigin - diff-seed the change map at the persist restore path', () => {
  it('makes the change map mean changes-vs-origin, equal to a direct diff of origin vs current', () => {
    const origin: string[] = ['a', 'b', 'c', 'd'];
    const current: string[] = ['a', 'B', 'c', 'D'];

    // The current state is the live document; the origin is the resolved persist
    // origin the change map must be measured against.
    const snapshot = new FileSnapshot(origin.join('\n'));
    snapshot.content.updateState(current);

    snapshot.seedTrackerFromOrigin(origin);

    expect(snapshot.content.getChangesLinesCount()).toBeGreaterThan(0);
    // The changed positions equal a direct HunkHelper.diff(origin, current).
    expect(snapshot.content.getChangedPositions([ChangeType.changed])).toEqual(diffPositions(origin, current));
    // The marker baseline is now the origin; the current state is untouched.
    expect(snapshot.content.getOriginalStateLines()).toEqual(origin);
    expect(snapshot.content.getLastStateLines()).toEqual(current);
  });

  it('paints nothing when the current content equals the resolved origin', () => {
    const origin: string[] = ['a', 'b', 'c'];

    const snapshot = new FileSnapshot(origin.join('\n'));
    snapshot.content.updateState(origin);

    snapshot.seedTrackerFromOrigin(origin);

    expect(snapshot.content.getChangesLinesCount()).toBe(0);
  });

  it('keeps the tracker aligned with the live document: an incremental edit lands on the right line', () => {
    const origin: string[] = ['a', 'b', 'c'];
    const current: string[] = ['a', 'B', 'c'];

    const snapshot = new FileSnapshot(origin.join('\n'));
    snapshot.content.updateState(current);
    snapshot.seedTrackerFromOrigin(origin);

    // A single incremental edit, applied exactly as the change detector does:
    // find the tracker at the edited current line and rewrite its content.
    snapshot.trackers.findCurrentLine(0)?.change('A');
    snapshot.content.updateState(['A', 'B', 'c']);
    snapshot.updateChanges();

    // Only the seeded change (line 1) and the fresh edit (line 0) are lit; the
    // untouched line 2 never flooded, so the tracker stayed mapped to the doc.
    expect(snapshot.content.getChangedPositions([ChangeType.changed])).toEqual([0, 1]);
  });

  it('seeds from the sliding persist origin resolved after a serialize/decode round-trip', () => {
    // Build a real history: baseline a,b,c, an intermediate captured version
    // a,B,c (the sliding origin), and a later current state a,B,C.
    const snapshot = new FileSnapshot('a\nb\nc');
    snapshot.trackers.findCurrentLine(1)?.change('B');
    snapshot.content.updateState(['a', 'B', 'c']);
    snapshot.updateChanges();
    snapshot.captureVersion(['a', 'B', 'c'], captureOptions(), true);
    snapshot.trackers.findCurrentLine(2)?.change('C');
    snapshot.content.updateState(['a', 'B', 'C']);
    snapshot.updateChanges();

    const restored = SnapshotCodec.decode(SnapshotCodec.encode(snapshot));
    const origin: string[] = resolveOrigin(restored, KeepHistory.persist);

    // The resolved persist origin is the oldest retained version, not the history
    // baseline, so the change map is bounded by retention.
    expect(origin).toEqual(['a', 'B', 'c']);

    restored.seedTrackerFromOrigin(origin);

    expect(restored.content.getChangesLinesCount()).toBeGreaterThan(0);
    expect(restored.content.getChangedPositions([ChangeType.changed]))
      .toEqual(diffPositions(origin, restored.content.getLastStateLines()));
    // The history baseline stays the full original so the modal is unaffected.
    expect(restored.content.getHistoryOriginalStateLines()).toEqual(['a', 'b', 'c']);
  });

  it('marks a removed line and preserves alignment when the origin has an extra line', () => {
    const origin: string[] = ['a', 'b', 'c'];
    const current: string[] = ['a', 'c'];

    const snapshot = new FileSnapshot(origin.join('\n'));
    snapshot.content.updateState(current);
    snapshot.seedTrackerFromOrigin(origin);

    // The deleted middle line is recorded as removed, and the surviving lines keep
    // their trackers so an edit still maps correctly.
    expect(snapshot.content.getChangesLinesCount()).toBeGreaterThan(0);
    expect(snapshot.content.getChanges(ChangeType.removed).size).toBe(1);
    expect(snapshot.content.getLastStateLines()).toEqual(current);
  });
});
