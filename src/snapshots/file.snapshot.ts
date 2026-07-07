import * as TextHelper from '@/helpers/text.helper';
import type { FileVersion } from '@/snapshots/file.version';
import { SnapshotState } from '@/snapshots/snapshot-state';
import { SnapshotTimestamps } from '@/snapshots/snapshot-timestamps';
import { TrackerEditor } from '@/snapshots/tracker-editor';
import { VersionTimeline } from '@/snapshots/version-timeline';
import type { SnapshotCaptureOptions } from '@/types';
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
   * Timestamp when this snapshot was created.
   * Used for tracking when changes occurred.
   */
  public timestamp: number = Date.now();

  /**
   * The content sub-object: the one narrow surface over the file's content.
   * It owns the marker baseline (`lines`), the history baseline (`historyLines`),
   * the current state (`state`) and its hash (`lastHash`), the change map
   * (`changes`), and the line break, and exposes the whole state/baseline/change
   * query API. Callers reach content queries through `snapshot.content`; the
   * façade only rewires its own composite operations (construction, serialization,
   * marker-baseline seeding, change-map refresh, history adoption) through it.
   */
  public readonly content: SnapshotState;

  /**
   * The tracker sub-object: the one narrow surface over line-change tracking.
   * It owns the tracker array (one TrackerLine per line, each tracking a line's
   * original/current position, content and change status) and the current-position
   * index cache, and exposes the whole tracker API - ordered reads, moves, shifts,
   * restores, removals, block replacement, the position lookups, the readonly view
   * and the build/restore/reset lifecycle. Callers reach tracking through
   * `snapshot.trackers`; the façade only rewires its own composite operations
   * (construction, serialization, marker-baseline seeding, change-map refresh)
   * through it.
   */
  public readonly trackers: TrackerEditor = new TrackerEditor();

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
   * insert in `SnapshotsService` sets this field; `SnapshotCodec.encode`
   * persists it (`file?.path ?? path`) and `SnapshotCodec.decode` restores it
   * from the serialized path.
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
   * first-opened pre-existing one. It is deliberately NOT persisted:
   * `SnapshotCodec.encode` never writes it and `SnapshotCodec.decode` never
   * reads it, so a snapshot restored from
   * `history.json` after a restart comes back falsy and the tree/tab decorator
   * stops painting it green once the session that created it ends.
   */
  public createdThisSession: boolean = false;

  /**
   * Creates a new instance of FileSnapshot.
   * Seeds the content sub-object with the provided text, builds a tracker per
   * baseline line, and records the initial state through the content owner.
   *
   * @param {string} content - The content of the file as a string
   * @param {string} lineBreak - The line break character used in the file (defaults to '\n')
   * @param {TFile | null} file - The Obsidian file object this snapshot belongs to
   */
  public constructor(content: string, lineBreak?: string, file?: TFile | null) {
    this.content = new SnapshotState(content, lineBreak);

    if (file) {
      this.file = file;
      this.path = file.path;
    }

    this.trackers.buildFromLines(this.content.lines);
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
    return this.content.lastHash !== TextHelper.hash(content);
  }

  /**
   * Authoritative content-equality check for the external-change guard
   *. Uses the 32-bit `lastHash` as a cheap pre-filter: a hash
   * mismatch is always a real change, but a hash match falls through to an
   * actual line-by-line compare against the snapshot's known `state` so a
   * collision (two distinct contents that hash to the same 32-bit value)
   * cannot make a genuine external rewrite look identical.
   *
   * The comparison splits the incoming content on `/\r?\n/` (the same separator
   * used when `state` was filled), so a change that differs only in trailing
   * whitespace or line count is detected even when the hashes collide.
   *
   * @param {string} content - The current content of the file to check
   * @return {boolean} True if the content differs from the stored state, false if identical
   */
  public isContentChanged(content: string): boolean {
    if (this.content.lastHash !== TextHelper.hash(content)) {
      return true;
    }

    const incoming: string[] = TextHelper.splitLines(content);
    const current: string[] = this.content.state;

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
        historyBaseline: this.content.getHistoryOriginalState(),
        lineBreak: this.content.lineBreak,
        options,
      },
      previousLines,
      force,
      label,
    );
  }

  /**
   * Returns a copy of the OLDEST retained version's lines, or undefined when the
   * timeline is empty. Delegates to the timeline so its internals stay
   * encapsulated; the origin resolver uses this as the sliding persist origin,
   * falling back to the history baseline only when no version survives.
   *
   * @return {string[] | undefined} The oldest retained version's lines, or undefined when empty
   */
  public getOldestRetainedLines(): string[] | undefined {
    return this.timeline.getOldestRetainedLines();
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
    this.content.adoptHistory(historyLines);
    this.timeline.adopt(Array.isArray(versions) ? [...versions] : []);

    if (typeof deletedTimestamp === 'number') {
      this.deletedTimestamp = deletedTimestamp;
    }
  }

  /**
   * Redefines the change map to mean "changes vs the resolved origin" while keeping
   * the tracker aligned with the live document. Adopts `origin` as the marker
   * baseline, rebuilds the tracker from it, then reconciles the tracker's current
   * view onto the current state via a minimal line diff, so the single cached
   * change map carries the changes-since-origin and every marker-derived surface
   * (gutter, tree/tab, status bar, reading-mode, properties, next/prev nav) follows
   * from it at once.
   *
   * At the persist restore path, rather than collapsing the baseline onto the
   * current state (session-clean), it seeds the baseline from the persisted
   * sliding origin so a restored snapshot reports its changes-vs-origin and
   * survives a reload. The reconcile keeps every untouched
   * line's tracker (and marker) in place and edits only genuinely changed lines, so
   * the tracker's current positions stay mapped to the live document and an
   * incremental edit from the change detector lands on the correct line.
   *
   * @param {string[]} origin - The resolved origin lines to diff the current state against
   */
  public seedTrackerFromOrigin(origin: string[]): void {
    const baseline: string[] = [...origin];

    this.content.lines = baseline;
    this.trackers.buildFromLines(baseline);
    this.trackers.reconcile(baseline, this.content.state);
    this.updateChanges();
  }

  /**
   * Re-seeds the change map when the resolved origin has slid off the current
   * marker baseline, the live-session counterpart of the persist-restore
   * seedTrackerFromOrigin. At keep=persist the marker baseline must always equal
   * the resolved origin (the oldest retained version); a capture that evicts that
   * version slides the origin forward, so the caller re-resolves it and hands the
   * new origin in here.
   *
   * When the passed origin already equals the marker baseline nothing moved, so
   * this is a no-op and returns false: a capture that leaves the oldest version
   * untouched costs only a line compare and never churns the tracker. Otherwise it
   * delegates to seedTrackerFromOrigin, which redefines the change map against the
   * new origin while keeping the tracker aligned with the live document, and
   * returns true. The snapshot stays settings-agnostic: the caller owns the
   * keep-gate and the origin resolution and passes only the resolved lines.
   *
   * @param {string[]} origin - The freshly resolved origin lines
   * @return {boolean} True when the baseline slid and the tracker was re-seeded
   */
  public reseedIfOriginSlid(origin: string[]): boolean {
    const baseline: string[] = this.content.lines;

    if (origin.length === baseline.length
      && origin.every((line: string, index: number): boolean => line === baseline[index])
    ) {
      return false;
    }

    this.seedTrackerFromOrigin(origin);

    return true;
  }

  /**
   * Updates the change map based on the current state of tracker lines.
   * Iterates through all tracker lines and adds appropriate change types
   * (added, removed, restored, changed) to the change map.
   */
  public updateChanges(): void {
    this.content.updateChanges(this.trackers.getTracker());
  }
}
