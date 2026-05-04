import { ChangeType } from '@/consts';
import { TextHelper } from '@/helpers/text.helper';
import { ChangeLine } from '@/lines/change.line';
import { TrackerLine } from '@/lines/tracker.line';
import { ArrayMap } from '@/maps/array.map';
import type { KeysMatching, TrackerLineParams } from '@/types';
import { isArray, isNumber, isString } from 'lodash-es';
import type { TFile } from 'obsidian';

/**
 * Represents a snapshot of a file's content with change tracking capabilities.
 * Track line additions, modifications, removals, and restorations over time.
 * Provides methods to query and manipulate the state of a file's content.
 */
export class FileSnapshot {
  /**
   * Unique identifier for this snapshot.
   * Generated randomly when the snapshot is created.
   */
  public id: string = TextHelper.rndId();

  /**
   * Original content of the file as an array of lines.
   * This represents the initial state of the file when the snapshot was created.
   */
  public lines: string[] = [];

  /**
   * Timestamp when this snapshot was created.
   * Used for tracking when changes occurred.
   */
  public timestamp: number = Date.now();

  /**
   * Map of line numbers to their corresponding change information.
   * Tracks what type of changes (added, modified, removed, restored) occurred at each line.
   */
  public changes: ArrayMap<ChangeLine> = new ArrayMap();

  /**
   * Array of tracker lines that maintain the history and state of each line.
   * Each TrackerLine object tracks a single line's original position, current position,
   * content, and change status.
   */
  public tracker: TrackerLine[] = [];

  /**
   * Lazily built index from a current line position to the tracker living there.
   * Covers only lines present in the current document and lets findCurrentLine
   * resolve in O(1) on the change-detection hot path instead of sorting and
   * copying the whole tracker each call. Null means stale: it is rebuilt on the
   * next lookup. Any mutation of a current position or of the tracker set must
   * call invalidateCurrentIndex().
   */
  protected currentIndex: Map<number, TrackerLine> | null = null;

  /**
   * Hash of the last known state of the file.
   * Used to determine if the file has changed since the last update.
   */
  public lastHash: string = null;

  /**
   * Current content of the file as an array of lines.
   * This represents the most recent state of the file.
   */
  public state: string[] = [];

  /**
   * Line break character used in the file.
   * Defaults to '\n' but can be specified during construction.
   */
  public lineBreak: string = '\n';

  /**
   * Reference to the Obsidian file object.
   * Used to identify which file this snapshot belongs to.
   */
  public file?: TFile | null;

  /**
   * Creates a new instance of FileSnapshot.
   * Initializes the snapshot with the provided content, splits it into lines,
   * creates tracker objects for each line, and saves the initial state.
   *
   * @param {string} content - The content of the file as a string
   * @param {string} lineBreak - The line break character used in the file (defaults to '\n')
   * @param {TFile | null} file - The Obsidian file object this snapshot belongs to
   */
  public constructor(content: string, lineBreak?: string, file?: TFile | null) {
    if (lineBreak) {
      this.lineBreak = lineBreak;
    }

    if (file) {
      this.file = file;
    }

    this.lines = content?.split(this.lineBreak) ?? [];

    this.tracker = this.lines.map((line: string, index: number): TrackerLine => new TrackerLine({
      content: line,
      originalPosition: index,
      currentPosition: index,
      contentSameOriginal: true,
    }));

    // save current content as last doc state
    this.updateState(this.lines);
  }

  /**
   * Checks if the file content has changed since the last update.
   * Compares the hash of the provided content with the stored hash.
   *
   * @param {string} content - The current content of the file to check
   * @return {boolean} True if the content has changed and needs updating, false otherwise
   */
  public isNeedUpdate(content: string): boolean {
    return this.lastHash !== TextHelper.hash(content);
  }

  /**
   * Updates the current state of the file snapshot.
   * Stores the new content and updates the hash for future change detection.
   *
   * @param {string | string[]} content - The new content of the file, either as a string or array of lines
   */
  public updateState(content: string | string[]): void {
    this.state = isArray(content) ? [...content] : content.split(this.lineBreak);
    this.lastHash = TextHelper.hash(this.state.join(this.lineBreak));
  }

  /**
   * Checks if the current state is the same as the original state.
   * Compares the content of the file when the snapshot was created with its current content.
   *
   * @return {boolean} True if the current state matches the original state, false otherwise
   */
  public isStateSameOriginal(): boolean {
    return this.getOriginalState() === this.getLastState();
  }

  /**
   * Gets the current state of the file as a string.
   * Joins the lines of the current state with the line break character.
   *
   * @return {string} The current state of the file as a string
   */
  public getLastState(): string {
    return this.state.join(this.lineBreak);
  }

  /**
   * Gets the current state of the file as an array of lines.
   * Returns a copy of the state array to prevent direct modification.
   *
   * @return {string[]} The current state of the file as an array of lines
   */
  public getLastStateLines(): string[] {
    return [...this.state];
  }

  /**
   * Gets the original state of the file as a string.
   * Joins the lines of the original state with the line break character.
   *
   * @return {string} The original state of the file as a string
   */
  public getOriginalState(): string {
    return [...this.lines].join(this.lineBreak);
  }

  /**
   * Gets the original state of the file as an array of lines.
   * Returns a copy of the lines array to prevent direct modification.
   *
   * @return {string[]} The original state of the file as an array of lines
   */
  public getOriginalStateLines(): string[] {
    return [...this.lines];
  }

  /**
   * Gets the changes for the specified change types.
   * If no type is specified, returns all changes.
   *
   * @param {ChangeType | ChangeType[]} type - Optional change type or array of change types to filter by
   * @return {ArrayMap<ChangeLine>} A map of line numbers to their corresponding change information
   */
  public getChanges(type?: ChangeType | ChangeType[]): ArrayMap<ChangeLine> {
    if (!this.changes) {
      this.changes = new ArrayMap<ChangeLine>();
    }

    if (type) {
      return ArrayMap.make(
        this.changes
          .filter((change: ChangeLine): boolean => change.has(type))
          .map((change: ChangeLine): ChangeLine => new ChangeLine(change.getLine(), change.getTypes())),
        (item: ChangeLine): number => item.getLine(),
      );
    }

    return this.changes;
  }

  /**
   * Gets the total count of lines that have been changed, added, or removed.
   * Used to display the number of changed lines in the status bar.
   *
   * @return {number} The number of lines with changes
   */
  public getChangesLinesCount(): number {
    return this.getChanges([ChangeType.changed, ChangeType.added, ChangeType.removed]).size;
  }

  /**
   * Retrieves the last modified date and time as a localized string.
   *
   * @return {string} The date and time of the last change in a localized string format.
   */
  public getLastChangedDateTime(): string {
    return new Date(this.timestamp).toLocaleString();
  }

  /**
   * Updates the change map based on the current state of tracker lines.
   * Iterates through all tracker lines and adds appropriate change types
   * (added, removed, restored, changed) to the change map.
   */
  public updateChanges(): void {
    const store: ArrayMap<ChangeLine> = this.getChanges();

    store.clear();

    this.getTracker().forEach((lineTracker: TrackerLine): void => {
      // Ideally, this situation could never happen
      if (!lineTracker || lineTracker.isStateGhost()) {
        return;
      }

      const position: number = lineTracker.isStateRemoved()
        ? lineTracker.removedAtPosition
        : lineTracker.currentPosition;

      const line: ChangeLine = store.get(position) ?? new ChangeLine(position, []);

      if (!store.has(position)) {
        store.set(position, line);
      }

      if (lineTracker.isStateRemoved()) {
        line.add(ChangeType.removed);

        return;
      }

      if (lineTracker.isStateAdded()) {
        line.add(ChangeType.added);

        return;
      }

      if (lineTracker.isStateRestored()) {
        line.add(ChangeType.restored);

        return;
      }

      if (lineTracker.isStateChanged()) {
        line.add(ChangeType.changed);

        return;
      }
    });
  }

  /**
   * Marks the current-position index as stale so it is rebuilt on next lookup.
   * Called by every mutation that can change a current position or the tracker set.
   */
  protected invalidateCurrentIndex(): void {
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
  protected getCurrentIndex(): Map<number, TrackerLine> {
    if (this.currentIndex) {
      return this.currentIndex;
    }

    const index: Map<number, TrackerLine> = new Map();

    for (const tracker of this.tracker) {
      if (tracker.existedInCurrent && !index.has(tracker.currentPosition)) {
        index.set(tracker.currentPosition, tracker);
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
    // Find the logical line currently at the desired position
    const tracker: TrackerLine | undefined = this.getCurrentIndex().get(line);

    if (!tracker) {
      return null;
    }

    // Preserve the original upper-bound guard so an out-of-range request misses.
    return tracker.isCurrentInRange(0, to) ? tracker : null;
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
    // We find the logical line currently at the desired position
    return this.getTracker().find((tracker: TrackerLine): boolean =>
      (visible ? tracker.isCurrentAt(line) : tracker.isOriginAt(line)) &&
      tracker.existedInOriginal &&
      tracker.isOriginalInRange(0, to)
    ) ?? null;
  }

  /**
   * Finds a tracker line removed at the specified position.
   * Searches for a tracker line that was removed at the given line number.
   *
   * @param {number} line - The line number where a line was removed
   * @return {TrackerLine | null} The tracker line that was removed at the specified position, or null if not found
   */
  public findRemovedAt(line: number): TrackerLine | null {
    // Pick the most recently removed line at the position (highest timestamp)
    // by scanning the tracker once, without sorting or copying it.
    let found: TrackerLine | null = null;

    for (const tracker of this.tracker) {
      if (tracker.isStateRemovedAt(line) && (!found || tracker.removedTimeStamp > found.removedTimeStamp)) {
        found = tracker;
      }
    }

    return found;
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

    const sort: KeysMatching<TrackerLine, number | string> = isArray(ordering) ? ordering[0] : ordering;
    const direction: string = isArray(ordering) ? ordering[1] : 'asc';
    const list: TrackerLine[] = [...this.tracker];

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
   * @param {number} line - The current line number of the tracker to move
   * @param {number} position - The new position to move the tracker to
   * @return {TrackerLine | null} The moved tracker line, or null if no tracker was found at the specified line
   */
  public moveTo(line: number, position: number): TrackerLine | null {
    const tracker: TrackerLine | null = this.findCurrentLine(line);

    if (!tracker) {
      return null;
    }

    if (tracker.isCurrentAt(position)) {
      return tracker;
    }

    if (tracker.isCurrentLT(position)) {
      this.shiftUp(line, tracker.getCurrentPositionOffset(position));
    }

    if (tracker.isCurrentGT(position)) {
      this.shiftDown(line, tracker.getCurrentPositionOffset(position));
    }

    tracker.moveTo(position);
    this.invalidateCurrentIndex();

    return tracker;
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

    this.invalidateCurrentIndex();

    this.tracker.forEach((tracker: TrackerLine): void => {
      if (tracker.isCurrentInRange(line, to)) {
        tracker.shiftUp(offset);
        (positions[tracker.currentPosition] || (positions[tracker.currentPosition] = [])).push(tracker);
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

    // Only removed lines are in range here, and shifting them touches their
    // removedAtPosition, not any current position, so the current index stays valid.
    this.tracker.forEach((tracker: TrackerLine): void => {
      if (tracker.isRemoveInRange(line, to)) {
        tracker.shiftUp(offset);
        (positions[tracker.removedAtPosition] || (positions[tracker.removedAtPosition] = [])).push(tracker);
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

    this.invalidateCurrentIndex();

    this.tracker.forEach((tracker: TrackerLine): void => {
      if (tracker.isCurrentInRange(line, to)) {
        tracker.shiftDown(offset);
        (positions[tracker.currentPosition] || (positions[tracker.currentPosition] = [])).push(tracker);
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

    // Only removed lines are in range here, and shifting them touches their
    // removedAtPosition, not any current position, so the current index stays valid.
    this.tracker.forEach((tracker: TrackerLine): void => {
      if (tracker.isRemoveInRange(line, to)) {
        tracker.shiftDown(offset);
        (positions[tracker.removedAtPosition] || (positions[tracker.removedAtPosition] = [])).push(tracker);
      }
    });

    return positions;
  }

  /**
   * Restores a removed tracker line or adds a new one at the specified position.
   * If a removed tracker line is found at the position, it is restored.
   * Otherwise, a new tracker line is added.
   *
   * @param {number | TrackerLine} line - The line number or tracker line to restore or add
   * @param {boolean} shift - Whether to shift other lines to accommodate the restored/added line
   * @return {TrackerLine} The restored or added tracker line
   */
  public restoreOrAddTracker(line: number | TrackerLine, shift: boolean = true): TrackerLine {
    const removed: TrackerLine | null = line instanceof TrackerLine ? line : this.findRemovedAt(line);
    const index: number = line instanceof TrackerLine ? line.removedAtPosition : line;

    if (shift) {
      this.shiftUp(index);
    }

    if (removed) {
      removed.restore(index);
      // restore() rewrites currentPosition directly, so the index can be stale
      // even when shift is false (shiftUp would otherwise have invalidated it).
      this.invalidateCurrentIndex();
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
   * @return {TrackerLine | null} The removed tracker line, or null if no tracker was found
   */
  public removeTrackerOrLine(line: number | TrackerLine, shift: boolean = true): TrackerLine | null {
    const tracker: TrackerLine | null = line instanceof TrackerLine ? line : this.findCurrentLine(line);
    const index: number = line instanceof TrackerLine ? line.currentPosition : line;
    const existedInOriginal: boolean = tracker?.existedInOriginal;

    if (!tracker) {
      return null;
    }

    if (shift) {
      this.shiftDown(index + 1);
      this.shiftDownRemoved(index + 1);
    }

    if (existedInOriginal) {
      tracker.remove();
    } else {
      this.removeTrackerLine(tracker);
    }

    // remove() drops currentPosition to -1; removeTrackerLine drops the entry.
    // Either way the current index no longer reflects the tracker set.
    this.invalidateCurrentIndex();

    return tracker;
  }

  /**
   * Adds a new tracker line to the snapshot.
   * Creates a new TrackerLine instance with the provided parameters and adds it to the tracker array.
   *
   * @param {TrackerLineParams} params - Optional parameters for the new tracker line
   * @return {TrackerLine} The newly created tracker line
   */
  public addTrackerLine(params ?: TrackerLineParams): TrackerLine {
    const tracker = new TrackerLine(params);

    this.tracker.push(tracker);
    this.invalidateCurrentIndex();

    return tracker;
  }

  /**
   * Removes a tracker line from the snapshot.
   * Finds the tracker line by line number or reference and removes it from the tracker array.
   *
   * @param {number | TrackerLine} line - The line number or tracker line to remove
   */
  public removeTrackerLine(line: number | TrackerLine): void {
    const index: number = this.tracker.findIndex((tracker: TrackerLine): boolean =>
      line instanceof TrackerLine ? tracker.isEq(line) : tracker.isCurrentAt(line)
    );

    if (index === -1) {
      return;
    }

    this.tracker.splice(index, 1);
    this.invalidateCurrentIndex();
  }
}
