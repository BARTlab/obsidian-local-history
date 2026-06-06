import { TrackerLine } from '@/lines/tracker.line';
import { ArrayMap } from '@/maps/array.map';
import type { TrackerIndex } from '@/snapshots/tracker-index';
import type { KeysMatching, TrackerLineParams } from '@/types';
import { isArray, isNumber, isString } from 'lodash-es';

/**
 * Owns the tracker mutation concern extracted from FileSnapshot: ordered reads,
 * moves, shifts, restores, removals, and block replacement over the shared
 * tracker array. The tracker array stays a writable façade field (external code
 * assigns `snapshot.tracker = []`); this collaborator mutates the array passed in
 * but never owns or copies it. Every mutation that can change a current position
 * or the tracker set calls `index.invalidate()` so the current-position cache is
 * rebuilt on next lookup; the `*Removed` shifts deliberately do NOT invalidate
 * because they touch `removedAtPosition`, not any current position. The façade
 * hands one TrackerIndex instance to the constructor so invalidation is owned in
 * exactly one place and never re-implemented on the façade.
 */
export class TrackerEditor {
  /**
   * The current-position index whose cache this editor invalidates after each
   * mutation and consults for its own findCurrentLine/findRemovedAt lookups. The
   * façade shares the same instance with the index-side reads so the cache stays
   * coherent across both collaborators.
   */
  protected index: TrackerIndex;

  /**
   * Creates a tracker editor bound to the shared current-position index.
   *
   * @param {TrackerIndex} index - The index whose cache this editor invalidates
   */
  public constructor(index: TrackerIndex) {
    this.index = index;
  }

  /**
   * Gets the tracker lines with optional sorting and key mapping.
   * Returns an ArrayMap of tracker lines that can be sorted and keyed as specified.
   *
   * @param {TrackerLine[]} tracker - The shared tracker array to order
   * @param {object} params - Optional parameters for sorting and keying the tracker lines
   * @param {string} params.keyBy - Property to use as the key in the returned ArrayMap
   * @param {Array|string} params.ordering - Property to sort by, or a tuple of property and direction
   * @return {ArrayMap<TrackerLine>} An ArrayMap of tracker lines
   */
  public getTracker(
    tracker: TrackerLine[],
    params?: {
      keyBy?: KeysMatching<TrackerLine, number | string>;
      ordering?: KeysMatching<TrackerLine, number | string>
        | [KeysMatching<TrackerLine, number | string>, 'asc' | 'dsc'];
    },
  ): ArrayMap<TrackerLine> {
    const {
      keyBy = 'key',
      ordering = 'key',
    } = params ?? {};

    const sort: KeysMatching<TrackerLine, number | string> = isArray(ordering) ? ordering[0] : ordering;
    const direction: string = isArray(ordering) ? ordering[1] : 'asc';
    const list: TrackerLine[] = [...tracker];

    list.sort((a: TrackerLine, b: TrackerLine): number => {
      const va: string | number = a[sort];
      const vb: string | number = b[sort];

      switch (direction) {
        case 'asc':
          if (isNumber(va) && isNumber(vb)) {
            return va - vb;
          }

          if (isString(va) && isString(vb)) {
            return va.localeCompare(vb);
          }

          break;

        case 'dsc':
          if (isNumber(va) && isNumber(vb)) {
            return vb - va;
          }

          if (isString(va) && isString(vb)) {
            return vb.localeCompare(va);
          }

          break;
      }
    });

    return ArrayMap.make(list, keyBy);
  }

  /**
   * Moves a tracker line to a new position.
   * Shifts other lines as needed to accommodate the move.
   *
   * @param {TrackerLine[]} tracker - The shared tracker array to mutate
   * @param {number} line - The current line number of the tracker to move
   * @param {number} position - The new position to move the tracker to
   * @return {TrackerLine | null} The moved tracker line, or null if no tracker was found at the specified line
   */
  public moveTo(tracker: TrackerLine[], line: number, position: number): TrackerLine | null {
    const found: TrackerLine | null = this.index.findCurrentLine(tracker, line);

    if (!found) {
      return null;
    }

    if (found.isCurrentAt(position)) {
      return found;
    }

    if (found.isCurrentLT(position)) {
      this.shiftUp(tracker, line, found.getCurrentPositionOffset(position));
    }

    if (found.isCurrentGT(position)) {
      this.shiftDown(tracker, line, found.getCurrentPositionOffset(position));
    }

    found.moveTo(position);
    this.index.invalidate();

    return found;
  }

  /**
   * Shifts tracker lines up by the specified offset.
   * Affects all tracker lines within the specified range.
   *
   * @param {TrackerLine[]} tracker - The shared tracker array to mutate
   * @param {number} line - The starting line number of the range to shift
   * @param {number} to - Optional ending line number of the range to shift
   * @param {number} offset - Optional number of lines to shift by (defaults to 1)
   * @return {Record<number, TrackerLine[]>} A record mapping line numbers to arrays of tracker lines at those positions
   */
  public shiftUp(tracker: TrackerLine[], line: number, to?: number, offset?: number): Record<number, TrackerLine[]> {
    const positions: Record<number, TrackerLine[]> = {};

    this.index.invalidate();

    tracker.forEach((item: TrackerLine): void => {
      if (item.isCurrentInRange(line, to)) {
        item.shiftUp(offset);
        (positions[item.currentPosition] || (positions[item.currentPosition] = [])).push(item);
      }
    });

    return positions;
  }

  /**
   * Shifts removed tracker lines up by the specified offset.
   * Affects all removed tracker lines within the specified range.
   *
   * @param {TrackerLine[]} tracker - The shared tracker array to mutate
   * @param {number} line - The starting line number of the range to shift
   * @param {number} to - Optional ending line number of the range to shift
   * @param {number} offset - Optional number of lines to shift by (defaults to 1)
   * @return {Record<number, TrackerLine[]>} A record mapping line numbers to arrays of tracker lines at those positions
   */
  public shiftUpRemoved(
    tracker: TrackerLine[],
    line: number,
    to?: number,
    offset?: number,
  ): Record<number, TrackerLine[]> {
    const positions: Record<number, TrackerLine[]> = {};

    /**
     * Only removed lines are in range here, and shifting them touches their
     * removedAtPosition, not any current position, so the current index stays valid.
     */
    tracker.forEach((item: TrackerLine): void => {
      if (item.isRemoveInRange(line, to)) {
        item.shiftUp(offset);
        (positions[item.removedAtPosition] || (positions[item.removedAtPosition] = [])).push(item);
      }
    });

    return positions;
  }

  /**
   * Shifts tracker lines down by the specified offset.
   * Affects all tracker lines within the specified range.
   *
   * @param {TrackerLine[]} tracker - The shared tracker array to mutate
   * @param {number} line - The starting line number of the range to shift
   * @param {number} to - Optional ending line number of the range to shift
   * @param {number} offset - Optional number of lines to shift by (defaults to 1)
   * @return {Record<number, TrackerLine[]>} A record mapping line numbers to arrays of tracker lines at those positions
   */
  public shiftDown(tracker: TrackerLine[], line: number, to?: number, offset?: number): Record<number, TrackerLine[]> {
    const positions: Record<number, TrackerLine[]> = {};

    this.index.invalidate();

    tracker.forEach((item: TrackerLine): void => {
      if (item.isCurrentInRange(line, to)) {
        item.shiftDown(offset);
        (positions[item.currentPosition] || (positions[item.currentPosition] = [])).push(item);
      }
    });

    return positions;
  }

  /**
   * Shifts removed tracker lines down by the specified offset.
   * Affects all removed tracker lines within the specified range.
   *
   * @param {TrackerLine[]} tracker - The shared tracker array to mutate
   * @param {number} line - The starting line number of the range to shift
   * @param {number} to - Optional ending line number of the range to shift
   * @param {number} offset - Optional number of lines to shift by (defaults to 1)
   * @return {Record<number, TrackerLine[]>} A record mapping line numbers to arrays of tracker lines at those positions
   */
  public shiftDownRemoved(
    tracker: TrackerLine[],
    line: number,
    to?: number,
    offset?: number,
  ): Record<number, TrackerLine[]> {
    const positions: Record<number, TrackerLine[]> = {};

    /**
     * Only removed lines are in range here, and shifting them touches their
     * removedAtPosition, not any current position, so the current index stays valid.
     */
    tracker.forEach((item: TrackerLine): void => {
      if (item.isRemoveInRange(line, to)) {
        item.shiftDown(offset);
        (positions[item.removedAtPosition] || (positions[item.removedAtPosition] = [])).push(item);
      }
    });

    return positions;
  }

  /**
   * Restores a removed tracker line or adds a new one at the specified position.
   * If a removed tracker line is found at the position, it is restored.
   * Otherwise, a new tracker line is added.
   *
   * @param {TrackerLine[]} tracker - The shared tracker array to mutate
   * @param {number | TrackerLine} line - The line number or tracker line to restore or add
   * @param {boolean} shift - Whether to shift other lines to accommodate the restored/added line
   * @return {TrackerLine} The restored or added tracker line
   */
  public restoreOrAddTracker(tracker: TrackerLine[], line: number | TrackerLine, shift: boolean = true): TrackerLine {
    const removed: TrackerLine | null = line instanceof TrackerLine ? line : this.index.findRemovedAt(tracker, line);
    const index: number = line instanceof TrackerLine ? line.removedAtPosition : line;

    if (shift) {
      this.shiftUp(tracker, index);
    }

    if (removed) {
      removed.restore(index);
      /**
       * restore() rewrites currentPosition directly, so the index can be stale
       * even when shift is false (shiftUp would otherwise have invalidated it).
       */
      this.index.invalidate();
    }

    if (shift) {
      this.shiftUpRemoved(tracker, index);
    }

    return removed ?? this.addTrackerLine(tracker, { currentPosition: index });
  }

  /**
   * Removes a tracker line or marks it as removed.
   * If the line existed in the original state, it is marked as removed.
   * Otherwise, it is completely removed from the tracker array.
   *
   * @param {TrackerLine[]} tracker - The shared tracker array to mutate
   * @param {number | TrackerLine} line - The line number or tracker line to remove
   * @param {boolean} shift - Whether to shift other lines to accommodate the removed line
   * @return {TrackerLine | null} The removed tracker line, or null if no tracker was found
   */
  public removeTrackerOrLine(
    tracker: TrackerLine[],
    line: number | TrackerLine,
    shift: boolean = true,
  ): TrackerLine | null {
    const found: TrackerLine | null = line instanceof TrackerLine ? line : this.index.findCurrentLine(tracker, line);
    const index: number = line instanceof TrackerLine ? line.currentPosition : line;
    const existedInOriginal: boolean = found?.existedInOriginal;

    if (!found) {
      return null;
    }

    if (shift) {
      this.shiftDown(tracker, index + 1);
      this.shiftDownRemoved(tracker, index + 1);
    }

    if (existedInOriginal) {
      found.remove();

      /**
       * Epic 13: keep the removed-line anchor on a real line. A block replaced by
       * a different line count is processed as delete + insert, removing the
       * doomed originals AFTER the replacements are inserted; each insert advances
       * the removed anchors (shiftUpRemoved). When the replaced block sits at the
       * document end (or the whole document is replaced, e.g. an empty file typed
       * full of new lines), the anchor is shifted past the last real line and the
       * removed gutter, which can only mark a real line, orphans it above the
       * title. Clamp the anchor to the last current line so the marker stays bound
       * to a real line at the bottom (the conventional "removed below here" spot).
       */
      const lastLine: number = this.lastCurrentLine(tracker);

      if (lastLine >= 0 && found.removedAtPosition > lastLine) {
        found.removedAtPosition = lastLine;
      }
    } else {
      this.removeTrackerLine(tracker, found);
    }

    /**
     * remove() drops currentPosition to -1; removeTrackerLine drops the entry.
     * Either way the current index no longer reflects the tracker set.
     */
    this.index.invalidate();

    return found;
  }

  /**
   * Adds a new tracker line to the snapshot.
   * Creates a new TrackerLine instance with the provided parameters and adds it to the tracker array.
   *
   * @param {TrackerLine[]} tracker - The shared tracker array to mutate
   * @param {TrackerLineParams} params - Optional parameters for the new tracker line
   * @return {TrackerLine} The newly created tracker line
   */
  public addTrackerLine(tracker: TrackerLine[], params?: TrackerLineParams): TrackerLine {
    const item = new TrackerLine(params);

    tracker.push(item);
    this.index.invalidate();

    return item;
  }

  /**
   * Returns the highest current line position present in the document, or -1 when
   * no line currently exists. Used to clamp a removed-line anchor so it can never
   * point past the last real line (epic 13).
   *
   * @param {TrackerLine[]} tracker - The shared tracker array to scan
   * @return {number} The last current line index, or -1 when the document is empty
   */
  protected lastCurrentLine(tracker: TrackerLine[]): number {
    let last: number = -1;

    for (const item of tracker) {
      if (item.existedInCurrent && item.currentPosition > last) {
        last = item.currentPosition;
      }
    }

    return last;
  }

  /**
   * Removes a tracker line from the snapshot.
   * Finds the tracker line by line number or reference and removes it from the tracker array.
   *
   * @param {TrackerLine[]} tracker - The shared tracker array to mutate
   * @param {number | TrackerLine} line - The line number or tracker line to remove
   */
  public removeTrackerLine(tracker: TrackerLine[], line: number | TrackerLine): void {
    const index: number = tracker.findIndex((item: TrackerLine): boolean =>
      line instanceof TrackerLine ? item.isEq(line) : item.isCurrentAt(line)
    );

    if (index === -1) {
      return;
    }

    tracker.splice(index, 1);
    this.index.invalidate();
  }

  /**
   * Replaces a contiguous block of current lines in the tracker with new content,
   * keeping the original baseline intact. This is the model-level counterpart of
   * a single-block edit: it is used when a region of the document is rewritten
   * outside the editor (for example a per-hunk revert from the history modal),
   * so the tracker and its highlights stay consistent with the new content even
   * when the change did not flow through the CodeMirror change detector.
   *
   * The block spanning [startLine, startLine + removeCount) is mapped onto
   * newLines. When the counts match, each line is edited in place so a revert to
   * the original content correctly clears or restores its highlight. When they
   * differ, the block is treated as a delete plus insert (mirroring the change
   * detector), which keeps positions correct for every line after the block.
   *
   * The caller is responsible for updating the cached state and the change map
   * afterwards (updateState then updateChanges), so the written file content
   * stays the single source of truth for the diff view.
   *
   * @param {TrackerLine[]} tracker - The shared tracker array to mutate
   * @param {number} startLine - The 0-based current position where the block begins
   * @param {number} removeCount - How many current lines the block currently spans
   * @param {string[]} newLines - The content the block should hold afterwards
   */
  public replaceBlock(tracker: TrackerLine[], startLine: number, removeCount: number, newLines: string[]): void {
    const start: number = Math.max(0, startLine);
    const count: number = Math.max(0, removeCount);
    const replacement: string[] = newLines ?? [];

    if (count === replacement.length && count > 0) {
      /**
       * Same line count in and out: edit each line in place. Editing back to the
       * original content flips contentSameOriginal, so the highlight clears.
       */
      for (let i: number = 0; i < count; i++) {
        this.index.findCurrentLine(tracker, start + i)?.change(replacement[i]);
      }

      return;
    }

    /**
     * Counts differ: delete the old block and insert the replacement, matching
     * the change detector so destroyed originals are removed and replacements
     * added without mismapping. Capture the doomed lines first, insert the new
     * ones, then remove the originals by reference.
     */
    const doomed: TrackerLine[] = [];

    for (let index: number = start; index < start + count; index++) {
      const found: TrackerLine | null = this.index.findCurrentLine(tracker, index);

      if (found) {
        doomed.push(found);
      }
    }

    replacement.forEach((content: string, offset: number): void => {
      this.restoreOrAddTracker(tracker, start + offset)?.change(content);
    });

    doomed.forEach((item: TrackerLine): void => {
      this.removeTrackerOrLine(tracker, item);
    });
  }
}
