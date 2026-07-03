import type { TrackerLine } from '@/lines/tracker.line';

/**
 * Owns the current-position index cache and the read-only lookups over the
 * tracker array. The array is owned by the tracker collaborators (shared with
 * TrackerEditor, which mutates it), not threaded in per call: this index holds
 * the same array reference and reads it directly. It is the single owner of the
 * lazily built `currentIndex` cache and its `invalidate`/`get`/rebuild:
 * TrackerEditor calls `invalidate()` after every mutation it performs, so
 * invalidation lives in exactly one place.
 */
export class TrackerIndex {
  /**
   * The shared tracker array this index reads. The same reference is held by
   * TrackerEditor, which mutates it in place; this index never reassigns it, so
   * the two collaborators always see the same array.
   */
  protected tracker: TrackerLine[];

  /**
   * Lazily built index from a current line position to the tracker living there.
   * Covers only lines present in the current document and lets findCurrentLine
   * resolve in O(1) on the change-detection hot path instead of sorting and
   * copying the whole tracker each call. Null means stale: it is rebuilt on the
   * next lookup. Any mutation of a current position or of the tracker set must
   * call invalidate().
   */
  protected currentIndex: Map<number, TrackerLine> | null = null;

  /**
   * Binds the index to the shared tracker array it reads.
   *
   * @param {TrackerLine[]} tracker - The shared tracker array, owned jointly with TrackerEditor
   */
  public constructor(tracker: TrackerLine[]) {
    this.tracker = tracker;
  }

  /**
   * Marks the current-position index as stale so it is rebuilt on next lookup.
   * Called by every mutation that can change a current position or the tracker set.
   */
  public invalidate(): void {
    this.currentIndex = null;
  }

  /**
   * Returns the current-position index, building it lazily when stale.
   * Maps each current line position to the tracker present there; lines absent
   * from the current document are skipped. On a position collision the first
   * tracker in array order wins, keeping the result deterministic.
   *
   * @return {Map<number, TrackerLine>} Index from current position to tracker
   */
  public get(): Map<number, TrackerLine> {
    if (this.currentIndex) {
      return this.currentIndex;
    }

    const index: Map<number, TrackerLine> = new Map();

    for (const item of this.tracker) {
      if (item.existedInCurrent && !index.has(item.currentPosition)) {
        index.set(item.currentPosition, item);
      }
    }

    this.currentIndex = index;

    return index;
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
    // Find the logical line currently at the desired position.
    const found: TrackerLine | undefined = this.get().get(line);

    if (!found) {
      return null;
    }

    // Preserve the original upper-bound guard so an out-of-range request misses.
    return found.isCurrentInRange(0, to) ? found : null;
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
    // Find the logical line currently at the desired position.
    return this.tracker.find((item: TrackerLine): boolean =>
      (visible ? item.isCurrentAt(line) : item.isOriginAt(line)) &&
      item.existedInOriginal &&
      item.isOriginalInRange(0, to)
    ) ?? null;
  }

  /**
   * Finds a tracker line removed at the specified position.
   * Searches for a tracker line that was removed at the given line number.
   * When `contentHash` is given, only an anchor whose last-held-content hash
   * matches is returned: an undo or paste-back re-inserting the line as it was
   * at deletion time finds its anchor, while unrelated new content typed at
   * the same position leaves the anchor (and its removed marker) in place.
   *
   * @param {number} line - The line number where a line was removed
   * @param {string} contentHash - Optional last-content hash the anchor must match
   * @return {TrackerLine | null} The tracker line that was removed at the specified position, or null if not found
   */
  public findRemovedAt(line: number, contentHash?: string): TrackerLine | null {
    /**
     * Pick the most recently removed line at the position (highest timestamp)
     * by scanning the tracker once, without sorting or copying it.
     */
    let found: TrackerLine | null = null;

    for (const item of this.tracker) {
      if (!item.isStateRemovedAt(line) || (found && item.removedTimeStamp <= found.removedTimeStamp)) {
        continue;
      }

      // Hash only the rare position candidates, not every tracked line.
      if (contentHash !== undefined && item.lastContentHash() !== contentHash) {
        continue;
      }

      found = item;
    }

    return found;
  }
}
