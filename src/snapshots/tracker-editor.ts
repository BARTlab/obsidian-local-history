import { assertNever } from '@/helpers/assert-never.helper';
import * as TextHelper from '@/helpers/text.helper';
import { TrackerLine } from '@/lines/tracker.line';
import { ArrayMap } from '@/maps/array.map';
import { TrackerIndex } from '@/snapshots/tracker-index';
import type { KeysMatching, SerializedFileSnapshot, TrackerLineParams } from '@/types';

/**
 * Owns the tracker array and the whole tracker surface FileSnapshot exposes as
 * `snapshot.trackers`: ordered reads, moves, shifts, restores, removals, block
 * replacement, the current-position lookups, the readonly view and the
 * build/restore/reset lifecycle. The array is owned here (shared with the
 * TrackerIndex it holds, which reads the same reference), not threaded in per
 * call. Every mutation that can change a current position or the tracker set
 * calls `index.invalidate()` so the current-position cache is rebuilt on next
 * lookup; the `*Removed` shifts deliberately do NOT invalidate because they touch
 * `removedAtPosition`, not any current position. The lifecycle operations
 * (buildFromLines/restore/reset) mutate the array in place so the shared index
 * always sees the same reference. This collaborator owns invalidation in exactly
 * one place, so it is never re-implemented on the façade.
 */
export class TrackerEditor {
  /**
   * The tracker array this editor owns. TrackerLine objects each track a single
   * line's original position, current position, content and change status. It is
   * mutated in place (never reassigned) so the TrackerIndex below, which holds the
   * same reference, always indexes the current set.
   */
  protected tracker: TrackerLine[] = [];

  /**
   * The current-position index whose cache this editor invalidates after each
   * mutation and consults for its own findCurrentLine/findRemovedAt lookups. It is
   * built over the same tracker array this editor owns, so the cache stays coherent
   * with every mutation.
   */
  protected index: TrackerIndex = new TrackerIndex(this.tracker);

  /**
   * Rebuilds the tracker from a marker baseline: one original tracker line per
   * baseline line, each marked same-as-original. Replaces the current set in place
   * and invalidates the shared index. Used by the façade constructor and by the
   * marker-baseline reset.
   *
   * @param {string[]} lines - The baseline lines to seed one tracker each
   */
  public buildFromLines(lines: string[]): void {
    this.tracker.length = 0;

    lines.forEach((line: string, index: number): void => {
      this.tracker.push(new TrackerLine({
        content: line,
        originalPosition: index,
        currentPosition: index,
        contentSameOriginal: true,
      }));
    });

    this.index.invalidate();
  }

  /**
   * Restores the persisted tracker verbatim from a serialized payload, replacing
   * the current set in place and invalidating the shared index. Used by the
   * façade's deserialization path.
   *
   * @param {SerializedFileSnapshot['tracker']} serialized - The persisted tracker entries
   */
  public restore(serialized: SerializedFileSnapshot['tracker']): void {
    this.tracker.length = 0;

    serialized.forEach((line): void => {
      this.tracker.push(TrackerLine.fromJSON(line));
    });

    this.index.invalidate();
  }

  /**
   * Clears the tracker so the snapshot carries no line-change state, invalidating
   * the shared index since the tracker set changed. Used by the tombstone and
   * cross-directory-move paths where the session marker view is meaningless once
   * the live file is gone.
   */
  public reset(): void {
    this.tracker.length = 0;
    this.index.invalidate();
  }

  /**
   * The narrow read surface over the tracker: the raw tracker lines in insertion
   * order as a readonly view, so callers can iterate and inspect (or reconcile a
   * single line through its own methods) without reassigning or reshaping the
   * array. Returns the live array rather than a copy because the change-detector
   * self-heal consumes it on the keystroke hot path.
   *
   * @return {readonly TrackerLine[]} The tracker lines in insertion order
   */
  public getTrackerLines(): readonly TrackerLine[] {
    return this.tracker;
  }

  /**
   * Finds a tracker line at the specified current position.
   * Searches for a tracker line that is currently at the given line number.
   *
   * @param {number} line - The line number to search for
   * @param {number} to - Optional upper bound for range checking
   * @return {TrackerLine | null} The tracker line at the specified position, or null if not found
   */
  public findCurrentLine(line: number, to?: number): TrackerLine | null {
    return this.index.findCurrentLine(line, to);
  }

  /**
   * Finds a tracker line originally at the specified position.
   * Can search for lines based on their original or current position.
   *
   * @param {number} line - The line number to search for
   * @param {number} to - Optional upper bound for range checking
   * @param {boolean} visible - If true, searches by current position; if false, by original position
   * @return {TrackerLine | null} The tracker line that was originally at the specified position, or null if not found
   */
  public findOriginalLine(line: number, to?: number, visible: boolean = true): TrackerLine | null {
    return this.index.findOriginalLine(line, to, visible);
  }

  /**
   * Finds a tracker line removed at the specified position.
   * Searches for a tracker line that was removed at the given line number.
   *
   * @param {number} line - The line number where a line was removed
   * @return {TrackerLine | null} The tracker line that was removed at the specified position, or null if not found
   */
  public findRemovedAt(line: number): TrackerLine | null {
    return this.index.findRemovedAt(line);
  }

  /**
   * Gets the tracker lines with optional sorting and key mapping.
   * Returns an ArrayMap of tracker lines that can be sorted and keyed as specified.
   *
   * @param {object} params - Optional parameters for sorting and keying the tracker lines
   * @param {string} params.keyBy - Property to use as the key in the returned ArrayMap
   * @param {Array|string} params.ordering - Property to sort by, or a tuple of property and direction
   * @return {ArrayMap<TrackerLine>} An ArrayMap of tracker lines
   */
  public getTracker(
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

    const sort: KeysMatching<TrackerLine, number | string> = Array.isArray(ordering) ? ordering[0] : ordering;
    const direction = Array.isArray(ordering) ? ordering[1] : 'asc';
    const list: TrackerLine[] = [...this.tracker];

    list.sort((a: TrackerLine, b: TrackerLine): number => {
      const va: string | number = a[sort];
      const vb: string | number = b[sort];

      switch (direction) {
        case 'asc':
          if (typeof va === 'number' && typeof vb === 'number') {
            return va - vb;
          }

          if (typeof va === 'string' && typeof vb === 'string') {
            return va.localeCompare(vb);
          }

          break;

        case 'dsc':
          if (typeof va === 'number' && typeof vb === 'number') {
            return vb - va;
          }

          if (typeof va === 'string' && typeof vb === 'string') {
            return vb.localeCompare(va);
          }

          break;

        default:
          assertNever(direction, 'sort direction');
      }

      // Non-comparable or mixed-type pairs keep their relative order.
      return 0;
    });

    return ArrayMap.make(list, keyBy);
  }

  /**
   * Moves a tracker line to a new position.
   * Shifts other lines as needed to accommodate the move.
   *
   * @param {number} line - The current line number of the tracker to move
   * @param {number} position - The new position to move the tracker to
   * @return {TrackerLine | null} The moved tracker line, or null if no tracker was found at the specified line
   */
  public moveTo(line: number, position: number): TrackerLine | null {
    const found: TrackerLine | null = this.index.findCurrentLine(line);

    if (!found) {
      return null;
    }

    if (found.isCurrentAt(position)) {
      return found;
    }

    if (found.isCurrentLT(position)) {
      this.shiftUp(line, found.getCurrentPositionOffset(position));
    }

    if (found.isCurrentGT(position)) {
      this.shiftDown(line, found.getCurrentPositionOffset(position));
    }

    found.moveTo(position);
    this.index.invalidate();

    return found;
  }

  /**
   * Shifts tracker lines up by the specified offset.
   * Affects all tracker lines within the specified range.
   *
   * @param {number} line - The starting line number of the range to shift
   * @param {number} to - Optional ending line number of the range to shift
   * @param {number} offset - Optional number of lines to shift by (defaults to 1)
   * @return {Record<number, TrackerLine[]>} A record mapping line numbers to arrays of tracker lines at those positions
   */
  public shiftUp(line: number, to?: number, offset?: number): Record<number, TrackerLine[]> {
    const positions: Record<number, TrackerLine[]> = {};

    this.index.invalidate();

    this.tracker.forEach((item: TrackerLine): void => {
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
   * @param {number} line - The starting line number of the range to shift
   * @param {number} to - Optional ending line number of the range to shift
   * @param {number} offset - Optional number of lines to shift by (defaults to 1)
   * @return {Record<number, TrackerLine[]>} A record mapping line numbers to arrays of tracker lines at those positions
   */
  public shiftUpRemoved(line: number, to?: number, offset?: number): Record<number, TrackerLine[]> {
    const positions: Record<number, TrackerLine[]> = {};

    /**
     * Only removed lines are in range here, and shifting them touches their
     * removedAtPosition, not any current position, so the current index stays valid.
     */
    this.tracker.forEach((item: TrackerLine): void => {
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
   * @param {number} line - The starting line number of the range to shift
   * @param {number} to - Optional ending line number of the range to shift
   * @param {number} offset - Optional number of lines to shift by (defaults to 1)
   * @return {Record<number, TrackerLine[]>} A record mapping line numbers to arrays of tracker lines at those positions
   */
  public shiftDown(line: number, to?: number, offset?: number): Record<number, TrackerLine[]> {
    const positions: Record<number, TrackerLine[]> = {};

    this.index.invalidate();

    this.tracker.forEach((item: TrackerLine): void => {
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
   * @param {number} line - The starting line number of the range to shift
   * @param {number} to - Optional ending line number of the range to shift
   * @param {number} offset - Optional number of lines to shift by (defaults to 1)
   * @return {Record<number, TrackerLine[]>} A record mapping line numbers to arrays of tracker lines at those positions
   */
  public shiftDownRemoved(line: number, to?: number, offset?: number): Record<number, TrackerLine[]> {
    const positions: Record<number, TrackerLine[]> = {};

    /**
     * Only removed lines are in range here, and shifting them touches their
     * removedAtPosition, not any current position, so the current index stays valid.
     */
    this.tracker.forEach((item: TrackerLine): void => {
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
   * When `content` is given, a removed anchor is restored only if the content
   * it held at deletion time matches: re-inserting the deleted line as it was
   * (undo, paste-back) folds the anchor back, while unrelated new content
   * typed at the anchor position adds a fresh tracker and leaves the deletion
   * record visible. A content-blind restore here silently converted a removal
   * plus an insertion into a single "changed" line, losing the removed marker.
   *
   * @param {number | TrackerLine} line - The line number or tracker line to restore or add
   * @param {boolean} shift - Whether to shift other lines to accommodate the restored/added line
   * @param {string} content - Optional content the restored anchor's last content must match
   * @return {TrackerLine} The restored or added tracker line
   */
  public restoreOrAddTracker(line: number | TrackerLine, shift: boolean = true, content?: string): TrackerLine {
    const contentHash: string | undefined = typeof content === 'string' ? TextHelper.hash(content) : undefined;
    const removed: TrackerLine | null = line instanceof TrackerLine
      ? line
      : this.index.findRemovedAt(line, contentHash);

    const index: number = line instanceof TrackerLine ? line.removedAtPosition : line;

    if (shift) {
      this.shiftUp(index);
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
      this.shiftUpRemoved(index);
    }

    return removed ?? this.addTrackerLine({ currentPosition: index });
  }

  /**
   * Removes a tracker line or marks it as removed.
   * If the line existed in the original state, it is marked as removed.
   * Otherwise, it is completely removed from the tracker array.
   *
   * @param {number | TrackerLine} line - The line number or tracker line to remove
   * @param {boolean} shift - Whether to shift other lines to accommodate the removed line
   * @param {boolean} clamp - Whether to re-clamp removed anchors right away. A caller
   *   removing several lines mid-operation (replaceBlock) defers the clamp to its own
   *   final pass: clamping against a temporarily shrunken document pins anchors above
   *   the block, and nothing ever lifts an anchor back up
   * @return {TrackerLine | null} The removed tracker line, or null if no tracker was found
   */
  public removeTrackerOrLine(
    line: number | TrackerLine,
    shift: boolean = true,
    clamp: boolean = true,
  ): TrackerLine | null {
    const found: TrackerLine | null = line instanceof TrackerLine ? line : this.index.findCurrentLine(line);
    const index: number = line instanceof TrackerLine ? line.currentPosition : line;

    if (!found) {
      return null;
    }

    const existedInOriginal: boolean = found.existedInOriginal;

    if (shift) {
      this.shiftDown(index + 1);
      this.shiftDownRemoved(index + 1);
    }

    if (existedInOriginal) {
      found.remove();

      if (clamp) {
        this.clampRemovedAnchors();
      }
    } else {
      this.removeTrackerLine(found);
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
   * @param {TrackerLineParams} params - Optional parameters for the new tracker line
   * @return {TrackerLine} The newly created tracker line
   */
  public addTrackerLine(params?: TrackerLineParams): TrackerLine {
    const item = new TrackerLine(params);

    this.tracker.push(item);
    this.index.invalidate();

    return item;
  }

  /**
   * Removes a tracker line from the snapshot.
   * Finds the tracker line by line number or reference and removes it from the tracker array.
   *
   * @param {number | TrackerLine} line - The line number or tracker line to remove
   */
  public removeTrackerLine(line: number | TrackerLine): void {
    const index: number = this.tracker.findIndex((item: TrackerLine): boolean =>
      line instanceof TrackerLine ? item.isEq(line) : item.isCurrentAt(line)
    );

    if (index === -1) {
      return;
    }

    this.tracker.splice(index, 1);
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
   * @param {number} startLine - The 0-based current position where the block begins
   * @param {number} removeCount - How many current lines the block currently spans
   * @param {string[]} newLines - The content the block should hold afterwards
   */
  public replaceBlock(startLine: number, removeCount: number, newLines: string[]): void {
    const start: number = Math.max(0, startLine);
    const count: number = Math.max(0, removeCount);
    const replacement: string[] = newLines ?? [];

    if (count === replacement.length && count > 0) {
      /**
       * Same line count in and out: edit each line in place. Editing back to the
       * original content flips contentSameOriginal, so the highlight clears.
       */
      for (let i: number = 0; i < count; i++) {
        this.index.findCurrentLine(start + i)?.change(replacement[i]);
      }

      return;
    }

    /**
     * Counts differ: delete the old block and insert the replacement, matching
     * the change detector so destroyed originals are removed and replacements
     * added without mismapping.
     */
    const doomed: TrackerLine[] = [];

    for (let index: number = start; index < start + count; index++) {
      const found: TrackerLine | null = this.index.findCurrentLine(index);

      if (found) {
        doomed.push(found);
      }
    }

    /**
     * Pair each replacement line with the first doomed original whose baseline
     * content matches, scanning monotonically so pairs keep their relative
     * order. A revert to the base content must fold back onto the original
     * tracker: dooming it and re-adding the same content anchored the original
     * as removed and brought its own text back as a phantom added line (the
     * same boundary-pairing blindness the change detector had for mid-line
     * splits and joins). Unpaired lines keep the delete + insert flow.
     */
    const claims = new Map<number, TrackerLine>();
    let scanFrom: number = 0;

    replacement.forEach((content: string, offset: number): void => {
      const contentHash: string = TextHelper.hash(content);

      for (let i: number = scanFrom; i < doomed.length; i++) {
        if (doomed[i].existedInOriginal && doomed[i].hash === contentHash) {
          claims.set(offset, doomed[i]);
          scanFrom = i + 1;
          break;
        }
      }
    });

    /**
     * Unpaired doomed lines go first so the survivors compact onto consecutive
     * positions from the block start; each unpaired insert below then shifts
     * them one step further down, which lands every survivor exactly on its
     * replacement offset by the time that offset is processed. The clamp is
     * deferred to the final pass below: clamping against the temporarily
     * shrunken document would pin anchors above the block, and shiftUpRemoved
     * never lifts an anchor sitting below the insert position back up.
     */
    const survivors: Set<TrackerLine> = new Set(claims.values());

    doomed.forEach((item: TrackerLine): void => {
      if (!survivors.has(item)) {
        this.removeTrackerOrLine(item, true, false);
      }
    });

    replacement.forEach((content: string, offset: number): void => {
      const survivor: TrackerLine | undefined = claims.get(offset);

      if (survivor) {
        survivor.change(content);

        return;
      }

      this.restoreOrAddTracker(start + offset, true, content)?.change(content);
    });

    /**
     * The placement pass ends with inserts, whose shiftUpRemoved can advance a
     * removed anchor past the last real line when the block sits at the
     * document end; removals run first here, so their own clamping cannot see
     * the final line count. Re-clamp once the block has its final shape.
     */
    this.clampRemovedAnchors();
  }

  /**
   * Keeps every removed-line anchor on a real line. Shifts around a block
   * whose line count changes (delete + insert, in either order) can advance an
   * anchor past the last real line, and the removed gutter, which can only
   * mark a real line, would orphan it above the title.
   *
   * Clamps ALL removed anchors, not just the one a caller touched: while a
   * multi-line block is processed, `lastCurrentLine` is inflated by doomed
   * lines that are still current, so an early anchor can stay below it and
   * escape a single-anchor clamp. Clamping the whole removed set on every call
   * means the final call (when only survivors remain) pulls every orphaned
   * anchor down to the last real line (the conventional "removed below here"
   * spot). No-op while no line currently exists: there is nothing to clamp to.
   */
  protected clampRemovedAnchors(): void {
    const lastLine: number = this.lastCurrentLine();

    if (lastLine < 0) {
      return;
    }

    for (const item of this.tracker) {
      if (item.isStateRemoved() && item.removedAtPosition > lastLine) {
        item.removedAtPosition = lastLine;
      }
    }
  }

  /**
   * Returns the highest current line position present in the document, or -1 when
   * no line currently exists. Used to clamp a removed-line anchor so it can never
   * point past the last real line.
   *
   * @return {number} The last current line index, or -1 when the document is empty
   */
  protected lastCurrentLine(): number {
    let last: number = -1;

    for (const item of this.tracker) {
      if (item.existedInCurrent && item.currentPosition > last) {
        last = item.currentPosition;
      }
    }

    return last;
  }
}
