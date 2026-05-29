import type { ChangeType } from '@/consts';
import { TextHelper } from '@/helpers/text.helper';
import type { ChangeLine } from '@/lines/change.line';
import { TrackerLine } from '@/lines/tracker.line';
import { ArrayMap } from '@/maps/array.map';
import type { FileVersion } from '@/snapshots/file.version';
import { SnapshotState } from '@/snapshots/snapshot-state';
import { SnapshotTimestamps } from '@/snapshots/snapshot-timestamps';
import { TrackerEditor } from '@/snapshots/tracker-editor';
import { TrackerIndex } from '@/snapshots/tracker-index';
import { VersionCodec } from '@/snapshots/version-codec';
import { VersionTimeline } from '@/snapshots/version-timeline';
import type { KeysMatching, SerializedFileSnapshot, SnapshotCaptureOptions, TrackerLineParams } from '@/types';
import { isNumber, isString } from 'lodash-es';
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
   * Marker baseline: the file content the change tracker measures against. This
   * is the file state at the moment the snapshot was created in the current app
   * run, so the gutter markers stay session-scoped (see D2). The tracker is
   * built from these lines and they never change for the life of the snapshot.
   */
  public lines: string[] = [];

  /**
   * History baseline: the persisted original the history modal diffs against
   * (see D2). Defaults to the marker baseline (`lines`) so a freshly captured
   * file has a single coherent origin. Restoring persisted history overrides
   * only this baseline (and the version timeline) through adoptHistory, leaving
   * the session marker baseline intact so the gutter does not mark the whole
   * file after a restart.
   */
  public historyLines: string[] = [];

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
   * The tracker-index collaborator that owns the lazily built current-position
   * cache and the read-only tracker lookups (findCurrentLine/findOriginalLine/
   * findRemovedAt) over the façade-owned `tracker` array. The same instance is
   * handed to the tracker editor so cache invalidation lives in one place.
   */
  protected index: TrackerIndex = new TrackerIndex();

  /**
   * The tracker-editor collaborator that performs every tracker mutation (moves,
   * shifts, restores, removals, block replacement) over the façade-owned
   * `tracker` array and invalidates the shared index after each one. It is a
   * stateless operator over the passed-in array; the array itself stays a
   * writable façade field external code assigns and mutates.
   */
  protected editor: TrackerEditor = new TrackerEditor(this.index);

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
   * Ordered timeline of intermediate versions, oldest first. Each entry is a
   * frozen copy of the file content at the moment it was captured. The original
   * baseline (lines) and the live state are not stored here; the timeline holds
   * only the points in between, which the history modal can diff against.
   */
  public versions: FileVersion[] = [];

  /**
   * The version-timeline collaborator that owns the capture cadence, the no-op
   * dedup, and the age/count eviction. It is a stateless operator over the
   * façade-owned `versions` array (which external code assigns and mutates), so
   * the façade passes that array in and writes the result back; the collaborator
   * holds only the cadence counters.
   */
  protected timeline: VersionTimeline = new VersionTimeline();

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
   * Tombstone marker (D1): the timestamp (ms) at which the underlying file was
   * deleted in the vault. While this is set, the snapshot represents a deleted
   * file whose final state and history are preserved for inspection and restore;
   * a live snapshot leaves the field `undefined`. The map keeps the entry under
   * its last-known path so a folder view at that prefix can still surface it.
   */
  public deletedTimestamp?: number;

  /**
   * Cross-directory move marker (D2): the timestamp (ms) at which this snapshot
   * was re-keyed to a new path because its file moved between directories. The
   * field stays `undefined` for a snapshot that has never been moved across
   * directories, and for the tombstone left behind in the source directory.
   */
  public movedIntoAt?: number;

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

    /**
     * The history baseline starts equal to the marker baseline; a restore can
     * later override it independently via adoptHistory.
     */
    this.historyLines = [...this.lines];

    this.tracker = this.lines.map((line: string, index: number): TrackerLine => new TrackerLine({
      content: line,
      originalPosition: index,
      currentPosition: index,
      contentSameOriginal: true,
    }));

    /**
     * Save the current content as the last document state.
     */
    this.updateState(this.lines);
  }

  /**
   * Serializes this snapshot into a plain object for on-disk persistence.
   * Persists the HISTORY baseline (so the modal can diff against the original
   * across restarts), the current state, and the full tracker so the highlights
   * can be restored verbatim. The session-scoped marker baseline is intentionally
   * not persisted: it is re-established from the file content on the next open
   * (see D2). The change map is omitted because it is recomputed from the tracker
   * on restore.
   *
   * @return {SerializedFileSnapshot} The plain serialized representation
   */
  public toJSON(): SerializedFileSnapshot {
    const payload: SerializedFileSnapshot = {
      path: this.file?.path ?? '',
      lineBreak: this.lineBreak,
      timestamp: this.timestamp,
      lines: [...this.historyLines],
      state: [...this.state],
      tracker: this.tracker.map((tracker: TrackerLine): ReturnType<TrackerLine['toJSON']> => tracker.toJSON()),
      versions: VersionCodec.encode(this.versions, this.lineBreak),
    };

    /**
     * Optional markers are written only when present so existing live-snapshot
     * payloads round-trip byte-identical and tombstones/moves are explicit.
     */
    if (isNumber(this.deletedTimestamp)) {
      payload.deletedTimestamp = this.deletedTimestamp;
    }

    if (isNumber(this.movedIntoAt)) {
      payload.movedIntoAt = this.movedIntoAt;
    }

    return payload;
  }

  /**
   * Rebuilds a snapshot from its serialized form.
   * Reconstructs the original baseline through the constructor, then replaces
   * the auto-generated tracker and current state with the persisted ones and
   * recomputes the change map. The file reference is attached separately by the
   * caller since serialized data only carries the path.
   *
   * @param {SerializedFileSnapshot} data - The serialized snapshot
   * @param {TFile | null} file - The file this snapshot belongs to, if known
   * @return {FileSnapshot} The reconstructed snapshot
   */
  public static fromJSON(data: SerializedFileSnapshot, file?: TFile | null): FileSnapshot {
    /**
     * Defensive deserialization (ADR-08-B): a corrupt or truncated history.json
     * must not crash plugin load. Each field is guarded individually so a single
     * malformed entry degrades to a safe default instead of throwing.
     */
    const lineBreak: string = isString(data.lineBreak) ? data.lineBreak : '\n';
    const lines: string[] = Array.isArray(data.lines) ? data.lines : [];
    const tracker: SerializedFileSnapshot['tracker'] = Array.isArray(data.tracker) ? data.tracker : [];
    const state: string[] = Array.isArray(data.state) ? data.state : [];

    const snapshot: FileSnapshot = new FileSnapshot(
      lines.join(lineBreak),
      lineBreak,
      file,
    );

    snapshot.timestamp = isNumber(data.timestamp) ? data.timestamp : Date.now();
    snapshot.tracker = tracker.map((line): TrackerLine => TrackerLine.fromJSON(line));
    snapshot.versions = VersionCodec.decode(data.versions, lineBreak);

    /**
     * T15: seed the timeline's time-gate counter from the newest restored
     * version so the interval-based capture cadence is continuous across a
     * restart. Without this the freshly constructed timeline would reset
     * `lastVersionAt` to load-time and re-arm the time gate for the full
     * interval even though a recent version is already on disk.
     */
    snapshot.timeline.seedLastVersionAtFromVersions(snapshot.versions);

    if (isNumber(data.deletedTimestamp)) {
      snapshot.deletedTimestamp = data.deletedTimestamp;
    }

    if (isNumber(data.movedIntoAt)) {
      snapshot.movedIntoAt = data.movedIntoAt;
    }

    snapshot.index.invalidate();
    snapshot.updateState(state);
    snapshot.updateChanges();

    return snapshot;
  }

  /**
   * Whether this snapshot is a tombstone for a deleted file (D1). True when
   * `deletedTimestamp` is set; false for a live snapshot.
   *
   * @return {boolean} True when the snapshot represents a deleted file
   */
  public isTombstone(): boolean {
    return isNumber(this.deletedTimestamp);
  }

  /**
   * Whether this snapshot was re-keyed to a new path by a cross-directory move
   * (D2). True when `movedIntoAt` is set; false otherwise.
   *
   * @return {boolean} True when the snapshot carries a move-in marker
   */
  public isMovedIn(): boolean {
    return isNumber(this.movedIntoAt);
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
   * Authoritative content-equality check for the external-change guard
   * (ADR-08-D). Uses the 32-bit `lastHash` as a cheap pre-filter: a hash
   * mismatch is always a real change, but a hash match falls through to an
   * actual line-by-line compare against the snapshot's known `state` so a
   * collision (two distinct contents that hash to the same 32-bit value)
   * cannot make a genuine external rewrite look identical.
   *
   * The comparison splits the incoming content on the snapshot's own
   * `lineBreak` (the same separator used when `state` was filled), so a
   * change that differs only in trailing whitespace or line count is detected
   * even when the hashes collide.
   *
   * @param {string} content - The current content of the file to check
   * @return {boolean} True if the content differs from the stored state, false if identical
   */
  public isContentChanged(content: string): boolean {
    if (this.lastHash !== TextHelper.hash(content)) {
      return true;
    }

    const incoming: string[] = content.split(this.lineBreak);
    const current: string[] = this.state;

    if (incoming.length !== current.length) {
      return true;
    }

    for (let i: number = 0; i < incoming.length; i++) {
      if (incoming[i] !== current[i]) {
        return true;
      }
    }

    return false;
  }

  /**
   * Updates the current state of the file snapshot.
   * Stores the new content and updates the hash for future change detection.
   *
   * @param {string | string[]} content - The new content of the file, either as a string or array of lines
   */
  public updateState(content: string | string[]): void {
    const result = SnapshotState.updateState(content, this.lineBreak);

    this.state = result.state;
    this.lastHash = result.lastHash;
  }

  /**
   * Records that the document changed since the last captured version and,
   * when the configured cadence is met, freezes the previous state as a new
   * intermediate version on the timeline.
   *
   * IMPORTANT: this must be called with the state BEFORE the latest edit was
   * applied (typically the snapshot's current state right before updateState),
   * so the captured version preserves the earlier point rather than the new
   * one. The current (newest) state is never stored as a version: the history
   * modal always has the live state available separately.
   *
   * Cadence: a version is captured when capture is enabled and either the edit
   * count since the last version reached editThreshold, or intervalMs elapsed
   * since the last version. A gate set to 0 is treated as disabled; when both
   * gates are 0 only the explicit force path captures. The timeline is bounded
   * primarily by age (maxVersionAgeDays) and secondarily by count (maxVersions),
   * evicting the oldest entries first so it cannot grow without limit.
   *
   * A no-op capture is skipped: when the content to freeze equals the most
   * recent stored version (or the original baseline when none exist), no version
   * is pushed. This keeps the timeline from holding adjacent duplicate entries
   * or a first version identical to the original, which would otherwise diff
   * identically and make switching the base appear to change nothing.
   *
   * A label-carrying capture is treated as a pinned marker (D6): it bypasses
   * the duplicate-skip so the user-supplied tag is always recorded, and the
   * resulting version is exempt from eviction in evictVersions.
   *
   * @param {string[]} previousLines - The content to freeze (pre-edit state)
   * @param {SnapshotCaptureOptions} options - The capture cadence configuration
   * @param {boolean} force - Capture regardless of the cadence gates
   * @param {string} label - Optional user-supplied tag that pins the version
   * @return {FileVersion | null} The captured version, or null if none was taken
   */
  public captureVersion(
    previousLines: string[],
    options: SnapshotCaptureOptions,
    force: boolean = false,
    label?: string,
  ): FileVersion | null {
    const result = this.timeline.capture(
      {
        versions: this.versions,
        historyBaseline: this.getHistoryOriginalState(),
        lineBreak: this.lineBreak,
        options,
      },
      previousLines,
      force,
      label,
    );

    this.versions = result.versions;

    return result.version;
  }

  /**
   * Returns the intermediate versions, newest first, as a copy so callers
   * cannot mutate the timeline.
   *
   * @return {FileVersion[]} The timeline versions, newest first
   */
  public getVersions(): FileVersion[] {
    return this.timeline.getVersions(this.versions);
  }

  /**
   * Finds an intermediate version by its id.
   *
   * @param {string} id - The version id to look up
   * @return {FileVersion | null} The matching version, or null if absent
   */
  public getVersion(id: string): FileVersion | null {
    return this.timeline.getVersion(this.versions, id);
  }

  /**
   * Removes a single intermediate version from the timeline by its id, leaving
   * the history baseline and every other version untouched. Used by the history
   * modal to prune one captured point without wiping the whole timeline.
   *
   * @param {string} id - The id of the version to remove
   * @return {boolean} True if a version was removed, false if no id matched
   */
  public removeVersion(id: string): boolean {
    return this.timeline.removeVersion(this.versions, id);
  }

  /**
   * Whether the snapshot has any intermediate versions on its timeline.
   *
   * @return {boolean} True when at least one version exists
   */
  public hasVersions(): boolean {
    return this.timeline.hasVersions(this.versions);
  }

  /**
   * Checks if the current state is the same as the original state.
   * Compares the content of the file when the snapshot was created with its current content.
   *
   * @return {boolean} True if the current state matches the original state, false otherwise
   */
  public isStateSameOriginal(): boolean {
    return SnapshotState.isStateSameOriginal(this.lines, this.state, this.lineBreak);
  }

  /**
   * Gets the current state of the file as a string.
   * Joins the lines of the current state with the line break character.
   *
   * @return {string} The current state of the file as a string
   */
  public getLastState(): string {
    return SnapshotState.getLastState(this.state, this.lineBreak);
  }

  /**
   * Gets the current state of the file as an array of lines.
   * Returns a copy of the state array to prevent direct modification.
   *
   * @return {string[]} The current state of the file as an array of lines
   */
  public getLastStateLines(): string[] {
    return SnapshotState.getLastStateLines(this.state);
  }

  /**
   * Gets the marker baseline as a string (the session origin the gutter markers
   * measure against). Joins the marker baseline lines with the line break.
   *
   * @return {string} The marker baseline of the file as a string
   */
  public getOriginalState(): string {
    return SnapshotState.getOriginalState(this.lines, this.lineBreak);
  }

  /**
   * Gets the marker baseline as an array of lines (the session origin the gutter
   * markers measure against). Returns a copy to prevent direct modification.
   *
   * @return {string[]} The marker baseline of the file as an array of lines
   */
  public getOriginalStateLines(): string[] {
    return SnapshotState.getOriginalStateLines(this.lines);
  }

  /**
   * Gets the HISTORY baseline as a string (the persisted original the history
   * modal diffs against). Distinct from the marker baseline so a restored file
   * keeps a stable origin for the time machine while the gutter stays
   * session-scoped (see D2).
   *
   * @return {string} The history baseline of the file as a string
   */
  public getHistoryOriginalState(): string {
    return SnapshotState.getHistoryOriginalState(this.historyLines, this.lineBreak);
  }

  /**
   * Gets the HISTORY baseline as an array of lines (the persisted original the
   * history modal diffs against). Returns a copy to prevent direct modification.
   *
   * @return {string[]} The history baseline of the file as an array of lines
   */
  public getHistoryOriginalStateLines(): string[] {
    return SnapshotState.getHistoryOriginalStateLines(this.historyLines);
  }

  /**
   * Adopts a persisted HISTORY baseline and version timeline into this
   * (session-captured) snapshot without touching the marker baseline, the
   * tracker, or the current state (see D2). Used by the restore path so reopening
   * a file in a new app run keeps the gutter markers session-scoped (measured
   * against the file content at this open) while the history modal still diffs
   * against the persisted original and its captured versions.
   *
   * @param {string[]} historyLines - The persisted original (history baseline)
   * @param {FileVersion[]} versions - The persisted version timeline, oldest first
   */
  public adoptHistory(historyLines: string[], versions: FileVersion[]): void {
    const result = SnapshotState.adoptHistory(historyLines, versions);

    this.historyLines = result.historyLines;
    this.versions = result.versions;
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

    return SnapshotState.getChanges(this.changes, type);
  }

  /**
   * Gets the total count of lines that have been changed, added, or removed.
   * Used to display the number of changed lines in the status bar.
   *
   * @return {number} The number of lines with changes
   */
  public getChangesLinesCount(): number {
    return SnapshotState.getChangesLinesCount(this.getChanges());
  }

  /**
   * Gets the 0-based positions of every currently changed line, ascending.
   * These are the same positions the line decorations are keyed by (the change
   * map keys), so navigating across them lands the cursor exactly on the
   * highlighted lines. Used by the "go to next/previous change" commands.
   *
   * @param {ChangeType | ChangeType[]} type - Optional change types to include;
   *   defaults to changed, added, restored and removed
   * @return {number[]} The unique changed line positions in ascending order
   */
  public getChangedPositions(type?: ChangeType | ChangeType[]): number[] {
    return SnapshotState.getChangedPositions(this.getChanges(), type);
  }

  /**
   * Resolves the timestamp of the file's last update. Prefers the file's
   * modification time (the real last-change moment of the live content), and
   * falls back to the snapshot's creation time when no file stat is available
   * (for example a detached snapshot in tests).
   *
   * @return {number} The last-change timestamp in milliseconds
   */
  public getLastChangedTimestamp(): number {
    return SnapshotTimestamps.getLastChangedTimestamp(this.file, this.timestamp);
  }

  /**
   * Retrieves the last modified date and time as a localized string.
   *
   * @return {string} The date and time of the last change in a localized string format.
   */
  public getLastChangedDateTime(): string {
    return SnapshotTimestamps.getLastChangedDateTime(this.file, this.timestamp);
  }

  /**
   * Retrieves the last modified day as a localized date string (no time), used
   * as the day-group key and label for the baseline entry in the history modal.
   *
   * @return {string} The localized last-change date
   */
  public getLastChangedDate(): string {
    return SnapshotTimestamps.getLastChangedDate(this.file, this.timestamp);
  }

  /**
   * Retrieves the last modified time of day as a localized string, shown as the
   * baseline entry's meta once its day lives in the group heading.
   *
   * @return {string} The localized last-change time
   */
  public getLastChangedTime(): string {
    return SnapshotTimestamps.getLastChangedTime(this.file, this.timestamp);
  }

  /**
   * Updates the change map based on the current state of tracker lines.
   * Iterates through all tracker lines and adds appropriate change types
   * (added, removed, restored, changed) to the change map.
   */
  public updateChanges(): void {
    SnapshotState.updateChanges(this.getChanges(), this.getTracker());
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
    return this.index.findCurrentLine(this.tracker, line, to);
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
    return this.index.findOriginalLine(this.tracker, line, to, visible);
  }

  /**
   * Finds a tracker line removed at the specified position.
   * Searches for a tracker line that was removed at the given line number.
   *
   * @param {number} line - The line number where a line was removed
   * @return {TrackerLine | null} The tracker line that was removed at the specified position, or null if not found
   */
  public findRemovedAt(line: number): TrackerLine | null {
    return this.index.findRemovedAt(this.tracker, line);
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
    return this.editor.getTracker(this.tracker, params);
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
    return this.editor.moveTo(this.tracker, line, position);
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
    return this.editor.shiftUp(this.tracker, line, to, offset);
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
    return this.editor.shiftUpRemoved(this.tracker, line, to, offset);
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
    return this.editor.shiftDown(this.tracker, line, to, offset);
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
    return this.editor.shiftDownRemoved(this.tracker, line, to, offset);
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
    return this.editor.restoreOrAddTracker(this.tracker, line, shift);
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
    return this.editor.removeTrackerOrLine(this.tracker, line, shift);
  }

  /**
   * Adds a new tracker line to the snapshot.
   * Creates a new TrackerLine instance with the provided parameters and adds it to the tracker array.
   *
   * @param {TrackerLineParams} params - Optional parameters for the new tracker line
   * @return {TrackerLine} The newly created tracker line
   */
  public addTrackerLine(params ?: TrackerLineParams): TrackerLine {
    return this.editor.addTrackerLine(this.tracker, params);
  }

  /**
   * Removes a tracker line from the snapshot.
   * Finds the tracker line by line number or reference and removes it from the tracker array.
   *
   * @param {number | TrackerLine} line - The line number or tracker line to remove
   */
  public removeTrackerLine(line: number | TrackerLine): void {
    this.editor.removeTrackerLine(this.tracker, line);
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
    this.editor.replaceBlock(this.tracker, startLine, removeCount, newLines);
  }
}
