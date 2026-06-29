import type { ChangeType } from '@/consts';
import { TextHelper } from '@/helpers/text.helper';
import type { ChangeLine } from '@/lines/change.line';
import type { TrackerLine } from '@/lines/tracker.line';
import { ArrayMap } from '@/maps/array.map';
import type { FileVersion } from '@/snapshots/file.version';
import { SnapshotState } from '@/snapshots/snapshot-state';
import { SnapshotTimestamps } from '@/snapshots/snapshot-timestamps';
import { TrackerEditor } from '@/snapshots/tracker-editor';
import { VersionCodec } from '@/snapshots/version-codec';
import { VersionTimeline } from '@/snapshots/version-timeline';
import type { SerializedFileSnapshot, SnapshotCaptureOptions } from '@/types';
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
   * run, so the gutter markers stay session-scoped. The tracker is
   * built from these lines and they never change for the life of the snapshot.
   */
  public lines: string[] = [];

  /**
   * History baseline: the persisted original the history modal diffs against
   *. Defaults to the marker baseline (`lines`) so a freshly captured
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
   * The tracker sub-object: the one narrow surface over line-change tracking.
   * It owns the tracker array (one TrackerLine per line, each tracking a line's
   * original/current position, content and change status) and the current-position
   * index cache, and exposes the whole tracker API - ordered reads, moves, shifts,
   * restores, removals, block replacement, the position lookups, the readonly view
   * and the build/restore/reset lifecycle. Callers reach tracking through
   * `snapshot.trackers`; the façade only rewires its own composite operations
   * (construction, serialization, marker-baseline reset, change-map refresh)
   * through it.
   */
  public readonly trackers: TrackerEditor = new TrackerEditor();

  /**
   * Hash of the last known state of the file.
   * Used to determine if the file has changed since the last update.
   */
  public lastHash: string | null = null;

  /**
   * Current content of the file as an array of lines.
   * This represents the most recent state of the file.
   */
  public state: string[] = [];

  /**
   * The version-timeline sub-object: the one narrow surface over intermediate
   * versions. It owns the ordered `versions` array (oldest first, one frozen copy
   * of the file content per captured point, holding only the points between the
   * baseline and the live state) together with the capture cadence, the no-op
   * dedup, and the age/count eviction. Callers reach version queries through
   * `snapshot.timeline`; the façade only rewires its own composite operations
   * (capture, serialization, history adoption) to read and write it.
   */
  public readonly timeline: VersionTimeline = new VersionTimeline();

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
   * Canonical vault-relative path of the snapshot, decoupled from a live
   * `TFile`. This mirrors the key the snapshot is stored under in
   * `SnapshotsService.fileSnapshots` and survives a reload: a restored snapshot
   * whose `file` did not resolve (restore miss, tombstone, orphan, detached
   * cross-directory move) still carries its path here, so folder-history path
   * resolution no longer depends on `file?.path` being non-null. Every map
   * insert in `SnapshotsService` sets this field; `toJSON` persists it
   * (`file?.path ?? path`) and `fromJSON` restores it from the serialized path.
   */
  public path: string = '';

  /**
   * Tombstone marker: the timestamp (ms) at which the underlying file was
   * deleted in the vault. While this is set, the snapshot represents a deleted
   * file whose final state and history are preserved for inspection and restore;
   * a live snapshot leaves the field `undefined`. The map keeps the entry under
   * its last-known path so a folder view at that prefix can still surface it.
   */
  public deletedTimestamp?: number;

  /**
   * Cross-directory move marker: the timestamp (ms) at which this snapshot
   * was re-keyed to a new path because its file moved between directories. The
   * field stays `undefined` for a snapshot that has never been moved across
   * directories, and for the tombstone left behind in the source directory.
   */
  public movedIntoAt?: number;

  /**
   * Transient "added in this app run" marker: set to `true` only
   * when the file was created by the user in the vault during the current
   * session (the post-layout-ready `vault.create` capture path stamps it). It
   * is the only reliable "created this run" signal, since `firstSeenAt` /
   * absence of `historyLines` cannot tell a newly created file from a
   * first-opened pre-existing one. It is deliberately NOT persisted: `toJSON`
   * never writes it and `fromJSON` never reads it, so a snapshot restored from
   * `history.json` after a restart comes back falsy and the tree/tab decorator
   * stops painting it green once the session that created it ends.
   */
  public createdThisSession: boolean = false;

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
      this.path = file.path;
    }

    this.lines = content?.split(this.lineBreak) ?? [];

    /**
     * The history baseline starts equal to the marker baseline; a restore can
     * later override it independently via adoptHistory.
     */
    this.historyLines = [...this.lines];

    this.trackers.buildFromLines(this.lines);

    // Save the current content as the last document state.
    this.updateState(this.lines);
  }

  /**
   * Serializes this snapshot into a plain object for on-disk persistence.
   * Persists the HISTORY baseline (so the modal can diff against the original
   * across restarts), the current state, and the full tracker so the highlights
   * can be restored verbatim. The session-scoped marker baseline is intentionally
   * not persisted: it is re-established from the file content on the next open
   *. The change map is omitted because it is recomputed from the tracker
   * on restore.
   *
   * @return {SerializedFileSnapshot} The plain serialized representation
   */
  public toJSON(): SerializedFileSnapshot {
    const payload: SerializedFileSnapshot = {
      path: this.file?.path ?? this.path,
      lineBreak: this.lineBreak,
      timestamp: this.timestamp,
      lines: [...this.historyLines],
      state: [...this.state],
      tracker: this.trackers.getTrackerLines()
        .map((tracker: TrackerLine): ReturnType<TrackerLine['toJSON']> => tracker.toJSON()),
      versions: VersionCodec.encode([...this.timeline.getStoredVersions()], this.lineBreak),
    };

    /**
     * Optional markers are written only when present so existing live-snapshot
     * payloads round-trip byte-identical and tombstones/moves are explicit.
     */
    if (typeof this.deletedTimestamp === 'number') {
      payload.deletedTimestamp = this.deletedTimestamp;
    }

    if (typeof this.movedIntoAt === 'number') {
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
     * Defensive deserialization: a corrupt or truncated history.json
     * must not crash plugin load. Each field is guarded individually so a single
     * malformed entry degrades to a safe default instead of throwing.
     */
    const lineBreak: string = typeof data.lineBreak === 'string' ? data.lineBreak : '\n';
    const lines: string[] = Array.isArray(data.lines) ? data.lines : [];
    const tracker: SerializedFileSnapshot['tracker'] = Array.isArray(data.tracker) ? data.tracker : [];
    const state: string[] = Array.isArray(data.state) ? data.state : [];

    const snapshot: FileSnapshot = new FileSnapshot(
      lines.join(lineBreak),
      lineBreak,
      file,
    );

    /**
     * The serialized path is the canonical map key. Seed it onto the
     * snapshot so a restored entry whose `file` did not resolve still resolves
     * its folder path without a live `TFile`. A `file`-bearing restore keeps the
     * same value (the key equals `file.path`), so this never disagrees with the
     * constructor's path seed.
     */
    snapshot.path = typeof data.path === 'string' ? data.path : snapshot.path;
    snapshot.timestamp = typeof data.timestamp === 'number' ? data.timestamp : Date.now();
    snapshot.trackers.restore(tracker);

    /**
     * Hand the decoded timeline to its owner, which adopts the array and seeds
     * both cadence gates from it so the interval and edit-count capture cadence
     * stay continuous across a restart (a freshly constructed timeline would
     * otherwise reset both gates to load-time even though recent versions are
     * already on disk).
     */
    snapshot.timeline.restore(VersionCodec.decode(data.versions ?? [], lineBreak));

    if (typeof data.deletedTimestamp === 'number') {
      snapshot.deletedTimestamp = data.deletedTimestamp;
    }

    if (typeof data.movedIntoAt === 'number') {
      snapshot.movedIntoAt = data.movedIntoAt;
    }

    snapshot.updateState(state);
    snapshot.updateChanges();

    return snapshot;
  }

  /**
   * Whether this snapshot is a tombstone for a deleted file. True when
   * `deletedTimestamp` is set; false for a live snapshot.
   *
   * @return {boolean} True when the snapshot represents a deleted file
   */
  public isTombstone(): boolean {
    return typeof this.deletedTimestamp === 'number';
  }

  /**
   * Whether this snapshot was re-keyed to a new path by a cross-directory move
   *. True when `movedIntoAt` is set; false otherwise.
   *
   * @return {boolean} True when the snapshot carries a move-in marker
   */
  public isMovedIn(): boolean {
    return typeof this.movedIntoAt === 'number';
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
   *. Uses the 32-bit `lastHash` as a cheap pre-filter: a hash
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
   * A label-carrying capture is treated as a pinned marker: it bypasses
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
    return this.timeline.capture(
      {
        historyBaseline: this.getHistoryOriginalState(),
        lineBreak: this.lineBreak,
        options,
      },
      previousLines,
      force,
      label,
    );
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
   * session-scoped.
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
   * tracker, or the current state. Used by the restore path so reopening
   * a file in a new app run keeps the gutter markers session-scoped (measured
   * against the file content at this open) while the history modal still diffs
   * against the persisted original and its captured versions.
   *
   * When the persisted snapshot carried a deletedTimestamp (i.e. it was a
   * tombstone on disk), that value is synced onto this snapshot so tombstone
   * data is never silently dropped when the session snapshot was created before
   * the restore path ran (A8).
   *
   * @param {string[]} historyLines - The persisted original (history baseline)
   * @param {FileVersion[]} versions - The persisted version timeline, oldest first
   * @param {number | undefined} deletedTimestamp - The persisted tombstone marker, if any
   */
  public adoptHistory(historyLines: string[], versions: FileVersion[], deletedTimestamp?: number): void {
    const result = SnapshotState.adoptHistory(historyLines, versions);

    this.historyLines = result.historyLines;
    this.timeline.adopt(result.versions);

    if (typeof deletedTimestamp === 'number') {
      this.deletedTimestamp = deletedTimestamp;
    }
  }

  /**
   * Re-establishes the session marker baseline at the current state, the eager
   * form of the "re-established from the file content on the next open" contract
   * that `toJSON` documents for the deliberately non-persisted marker baseline.
   *
   * `fromJSON` reconstructs the marker baseline from the persisted HISTORY
   * original and restores the persisted tracker, so a restored snapshot reports
   * its full history diff (`getChangesLinesCount() > 0`) before the file is ever
   * opened this run. The session surfaces that read a snapshot WITHOUT opening it
   * - the tree/tab decorator above all - would then paint a folder as changed on
   * a fresh launch even though nothing changed this session. Calling this at
   * restore collapses the marker baseline onto the current state so the snapshot
   * starts session-clean (`none`), matching the gutter, which re-baselines to the
   * editor content on open. The HISTORY baseline (`historyLines`) and the version
   * timeline are untouched, so the history modal keeps diffing against the
   * persisted original; only the session-scoped marker view is reset.
   */
  public resetMarkerBaseline(): void {
    this.lines = [...this.state];

    this.trackers.buildFromLines(this.lines);
    this.updateChanges();
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
    SnapshotState.updateChanges(this.getChanges(), this.trackers.getTracker());
  }
}
