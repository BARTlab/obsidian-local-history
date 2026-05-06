import { describe, expect, it } from '@jest/globals';
import { ChangeType } from '@/consts';
import { FileSnapshot } from '@/snapshots/file.snapshot';
import type { TrackerLine } from '@/lines/tracker.line';
import type { TFile } from 'obsidian';

/**
 * Round-trip tests for FileSnapshot persistence (T5.1). They drive the snapshot
 * through real edits, serialize it, rebuild it from the serialized form, and
 * assert the reconstructed snapshot reports the same change state. They also
 * pin the contract that restored tracker ids are fresh and collision-free.
 */

const makeFile = (path: string): TFile =>
  ({ path, name: path.split('/').pop() ?? path } as unknown as TFile);

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

    const ids: string[] = restored.tracker.map((line: TrackerLine): string => line.id);

    // No empty ids and no duplicates across the restored tracker.
    expect(ids.every((id: string): boolean => typeof id === 'string' && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);

    // Restored ids are independent objects from the source tracker.
    const sourceIds: Set<string> = new Set(snapshot.tracker.map((line: TrackerLine): string => line.id));
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
