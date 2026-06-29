import 'reflect-metadata';
import { describe, expect, it } from '@jest/globals';
import { ChangeType } from '@/consts';
import { FileSnapshot } from '@/snapshots/file.snapshot';

/**
 * Regression: a removed-line anchor must never land past the last real
 * line. The change detector treats a block replaced by a different line count as
 * delete + insert, removing the doomed originals AFTER inserting the
 * replacements. Each insert advances the removed-line anchors (shiftUpRemoved),
 * so when the replaced block sits at the document end (or the whole document is
 * replaced, e.g. an empty Untitled file typed full of new lines) a doomed line's
 * removedAtPosition was shifted beyond the last real line. The removed gutter can
 * only anchor a marker on a real line, so that out-of-range anchor detached and
 * rendered above the title. TrackerEditor.removeTrackerOrLine now clamps the
 * anchor to the last current line, keeping every marker bound to a real line.
 */

const removedAnchors = (snapshot: FileSnapshot): number[] =>
  snapshot.trackers.getTrackerLines()
    .filter((line): boolean => line.isStateRemoved())
    .map((line): number => line.removedAtPosition)
    .sort((a: number, b: number): number => a - b);

const lastLineIndex = (snapshot: FileSnapshot): number =>
  Math.max(...snapshot.trackers.getTrackerLines()
    .filter((line): boolean => line.existedInCurrent)
    .map((line): number => line.currentPosition));

const changeKeys = (snapshot: FileSnapshot): number[] =>
  [...snapshot.getChanges().keys()]
    .filter((key): key is number => typeof key === 'number')
    .sort((a: number, b: number): number => a - b);

describe('TrackerEditor removed-anchor clamping', () => {
  it('does not orphan a removed marker when the whole document is replaced', () => {
    // Empty Untitled file: a single empty original line at position 0.
    const snapshot = new FileSnapshot('');

    // The user types three lines, fully replacing the empty original. This is a
    // 1-line block replaced by 3 lines, i.e. delete + insert.
    snapshot.trackers.replaceBlock(0, 1, ['A', 'B', 'C']);
    snapshot.updateState(['A', 'B', 'C']);
    snapshot.updateChanges();

    // No removed anchor may sit past the last real line (index 2 here).
    const last: number = lastLineIndex(snapshot);

    removedAnchors(snapshot).forEach((anchor: number): void => {
      expect(anchor).toBeGreaterThanOrEqual(0);
      expect(anchor).toBeLessThanOrEqual(last);
    });

    // No change-map key may point above the title (negative) or past the end.
    changeKeys(snapshot).forEach((key: number): void => {
      expect(key).toBeGreaterThanOrEqual(0);
      expect(key).toBeLessThanOrEqual(last);
    });
  });

  it('keeps every removed anchor on a real line while deleting from the top', () => {
    const snapshot = new FileSnapshot('');

    snapshot.trackers.replaceBlock(0, 1, ['A', 'B', 'C']);
    snapshot.updateState(['A', 'B', 'C']);
    snapshot.updateChanges();

    // Delete the lines one by one from the top (line 0), mirroring repeated Del.
    const states: string[][] = [['B', 'C'], ['C'], []];

    states.forEach((state: string[]): void => {
      snapshot.trackers.removeTrackerOrLine(0);
      snapshot.updateState(state.length ? state : ['']);
      snapshot.updateChanges();

      const last: number = lastLineIndex(snapshot);

      removedAnchors(snapshot).forEach((anchor: number): void => {
        expect(anchor).toBeGreaterThanOrEqual(0);
        expect(anchor).toBeLessThanOrEqual(Math.max(0, last));
      });
    });
  });

  it('does not orphan anchors when many originals shrink to fewer lines', () => {
    // A multi-line original file replaced by fewer lines (e.g. select-all then
    // type one line). This is delete + insert where the removed count far
    // exceeds the inserted count, so several doomed originals are still current
    // (not yet removed) while the first ones are processed. The clamp must reach
    // the final surviving last line, not an inflated count that still includes
    // the pending doomed lines, or the early anchors orphan past the last line.
    const snapshot = new FileSnapshot('o1\no2\no3\no4\no5');

    snapshot.trackers.replaceBlock(0, 5, ['Z']);
    snapshot.updateState(['Z']);
    snapshot.updateChanges();

    // Only "Z" survives, at index 0. No removed anchor may exceed it.
    const last: number = lastLineIndex(snapshot);

    removedAnchors(snapshot).forEach((anchor: number): void => {
      expect(anchor).toBeGreaterThanOrEqual(0);
      expect(anchor).toBeLessThanOrEqual(last);
    });

    changeKeys(snapshot).forEach((key: number): void => {
      expect(key).toBeGreaterThanOrEqual(0);
      expect(key).toBeLessThanOrEqual(last);
    });
  });

  it('still anchors an interior removed block on the surviving line below it', () => {
    const snapshot = new FileSnapshot('a\nb\nc\nd');

    // Replace the interior block b, c with X, Y, Z -> a, X, Y, Z, d.
    snapshot.trackers.replaceBlock(1, 2, ['X', 'Y', 'Z']);
    snapshot.updateState(['a', 'X', 'Y', 'Z', 'd']);
    snapshot.updateChanges();

    // b and c are removed; their anchor stays on the surviving "d" (index 4),
    // which is a real line, so this path is unchanged by the clamp.
    const last: number = lastLineIndex(snapshot);

    expect(snapshot.getChanges(ChangeType.removed).size).toBeGreaterThan(0);

    removedAnchors(snapshot).forEach((anchor: number): void => {
      expect(anchor).toBeLessThanOrEqual(last);
    });
  });
});
