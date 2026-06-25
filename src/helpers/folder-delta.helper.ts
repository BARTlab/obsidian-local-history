import { FolderDeltaStatus } from '@/consts';
import type { FileSnapshot } from '@/snapshots/file.snapshot';
import type { FileVersion } from '@/snapshots/file.version';
import type { FolderDeltaResult } from '@/types';
import { isNumber } from 'lodash-es';

export { FolderDeltaStatus } from '@/consts';

/**
 * Pure helper that resolves the per-file delta from a chosen folder-timeline
 * point T to "now". Used by the folder modal tree to colour each file by
 * its status relative to T, and to feed the diff renderer when a file is
 * selected in that tree.
 *
 * Resolving the content at T mirrors the JetBrains Local History semantics:
 *
 * - The base for a live snapshot is the latest captured version whose
 *   `timestamp <= T`. When no version qualifies (the timeline is empty or T
 *   precedes the earliest captured version), the history baseline (the
 *   persisted original the modal already diffs against) is the natural
 *   fallback. When the snapshot itself was created after T (its `timestamp`
 *   exceeds T) the file did not yet exist at T, which is the `'added'` cell.
 * - The current side is the snapshot's live `state` for a live snapshot, and
 *   an empty array for a tombstone (the file is gone in the vault).
 *
 * The four-way status grid is the cross product of "did the file exist at T?"
 * and "does it exist now?". The helper resolves both questions from the
 * snapshot alone (no vault access), so it stays cheap to call per snapshot
 * for every redraw of the folder tree.
 */
export class FolderDeltaHelper {
  /**
   * Compares the snapshot's state at the timeline point T to its current
   * state. See the class docs for the full status grid and the resolution
   * rules; see {@link FolderDeltaResult} for the returned shape.
   *
   * The helper is defensive about a missing snapshot (returns `'none'` with
   * empty content) so callers iterating over a possibly-stale map can pass
   * `undefined` without guarding every call site.
   *
   * @param {FileSnapshot} snapshot - The snapshot to inspect (live or tombstone)
   * @param {number} timestamp - The chosen folder-timeline point T, in ms
   * @return {FolderDeltaResult} The resolved base / current / status triple
   */
  public static compareAt(snapshot: FileSnapshot | null | undefined, timestamp: number): FolderDeltaResult {
    if (!snapshot) {
      return { status: FolderDeltaStatus.none, base: [], current: [] };
    }

    const existedAtT: boolean = FolderDeltaHelper.existedAtT(snapshot, timestamp);
    const existsNow: boolean = !snapshot.isTombstone();
    const current: string[] = existsNow ? [...(snapshot.state ?? [])] : [];

    /**
     * The file is gone now and was already gone at T: there is nothing to show
     * on this row for this point in time. The folder tree filters these out.
     */
    if (!existsNow && !existedAtT) {
      return { status: FolderDeltaStatus.none, base: [], current: [] };
    }

    /**
     * The file did not exist at T but exists now (created or moved in later).
     * No base content to diff against; the diff renders as "everything green".
     */
    if (!existedAtT) {
      return { status: FolderDeltaStatus.added, base: [], current };
    }

    const base: string[] = FolderDeltaHelper.resolveBaseAt(snapshot, timestamp);

    /**
     * The file existed at T and is gone now (a tombstone deleted after T): the
     * diff renders as "everything red" against the base content at T.
     */
    if (!existsNow) {
      return { status: FolderDeltaStatus.deleted, base, current: [] };
    }

    /**
     * Both sides exist: an actual line-by-line comparison decides whether the
     * row is `modified` or `none` so the tree skips visually-equal files.
     */
    return {
      status: FolderDeltaHelper.contentEquals(base, current) ? FolderDeltaStatus.none : FolderDeltaStatus.modified,
      base,
      current,
    };
  }

  /**
   * Whether the snapshot represented a file present at its current path at T.
   * The answer drives the added / deleted / modified grid in {@link compareAt},
   * and crucially it is evaluated per the file's CURRENT path so a move shows up
   * as a deletion at the old path and an addition at the new one.
   *
   * Three cases:
   *
   * - Tombstone: existed at T when it was first seen at/before T and deleted at
   *   or AFTER T (`deletedTimestamp >= T`, inclusive). Inclusive on the delete
   *   instant so the file is still surfaced as `'deleted'` on the very timeline
   *   point that represents its deletion (or its move-out, which leaves a
   *   tombstone stamped at the move instant); an exclusive bound hid the deleted
   *   file on its own point and made the newest snapshot look empty.
   *
   * - Moved-in live snapshot: the file appears at its destination path only
   *   strictly AFTER the move (`movedIntoAt < T`). At and before the move instant
   *   it is treated as not-yet-here, so the move-in timeline point renders it as
   *   freshly `'added'` to the folder (green) while the tombstone left at the old
   *   path renders as `'deleted'` (red): together they read as a move. Its
   *   pre-move captured history belongs to the old path and is deliberately not
   *   consulted for existence at the new one.
   *
   * - Plain live snapshot: existed at T when its earliest known moment
   *   ({@link firstSeenAt}) is at/before T. The floor is the earliest of the
   *   snapshot's `timestamp` and its version timestamps, NOT `timestamp` alone:
   *   `timestamp` is reset to `Date.now()` whenever the snapshot object is
   *   rebuilt, so it drifts NEWER than the file's own captured history and using
   *   it alone misclassified long-lived files as `'added'` (empty base, all-green
   *   diff) at every point before it.
   *
   * @param {FileSnapshot} snapshot - The snapshot under inspection
   * @param {number} timestamp - The chosen timeline point T, in ms
   * @return {boolean} True when the file was present at its current path at T
   */
  protected static existedAtT(snapshot: FileSnapshot, timestamp: number): boolean {
    if (snapshot.isTombstone()) {
      if (FolderDeltaHelper.firstSeenAt(snapshot) > timestamp) {
        return false;
      }

      return isNumber(snapshot.deletedTimestamp) && snapshot.deletedTimestamp >= timestamp;
    }

    if (snapshot.isMovedIn()) {
      return isNumber(snapshot.movedIntoAt) && snapshot.movedIntoAt < timestamp;
    }

    return FolderDeltaHelper.firstSeenAt(snapshot) <= timestamp;
  }

  /**
   * Resolves the earliest moment the file is known to have existed: the minimum
   * of the snapshot's creation `timestamp` and every captured version timestamp.
   * Versions are recorded with their true historical timestamps, so the earliest
   * one is an older, more reliable existence floor than `timestamp`, which drifts
   * to "now" each time the snapshot object is rebuilt (see {@link existedAtT}).
   *
   * Falls back to `+Infinity` when neither a numeric `timestamp` nor any version
   * timestamp is available, so a degenerate snapshot is treated as never having
   * existed rather than as existing since the epoch.
   *
   * @param {FileSnapshot} snapshot - The snapshot whose existence floor to resolve
   * @return {number} The earliest known timestamp, or `+Infinity` when unknown
   */
  protected static firstSeenAt(snapshot: FileSnapshot): number {
    let earliest: number = isNumber(snapshot.timestamp) ? snapshot.timestamp : Number.POSITIVE_INFINITY;

    const versions: FileVersion[] = Array.isArray(snapshot.versions) ? snapshot.versions : [];

    for (const version of versions) {
      if (version && isNumber(version.timestamp) && version.timestamp < earliest) {
        earliest = version.timestamp;
      }
    }

    return earliest;
  }

  /**
   * Resolves the file's content at T as the captured version whose timestamp
   * is the latest at or before T, falling back to the persisted history
   * baseline when no version qualifies. The snapshot's `versions` array is
   * stored oldest-first (by capture order), so scanning back from the end
   * finds the qualifying version in one pass.
   *
   * No-version live files are a special case (handled first). A file edited
   * once below the capture cadence has no intermediate versions, so only two
   * states are known: the history baseline (earliest) and the current state,
   * reached at the file's last-change moment ({@link FileSnapshot.getLastChangedTimestamp},
   * the file's mtime). Treating that moment as the single transition, the
   * content at T is the current state for any T at/after it (so the file reads
   * as unchanged - `'none'` - since T) and the baseline before it. Without this,
   * a no-version file always diffs the baseline against the current state and
   * so shows as `'modified'` at every timeline point, even the newest.
   * Tombstones keep the baseline fallback: their captured-or-baseline content is
   * the recoverable starting point and their current side is empty regardless.
   *
   * Returns a copy of the lines so the caller cannot mutate the underlying
   * version or the history baseline through the returned reference.
   *
   * @param {FileSnapshot} snapshot - The snapshot whose content to resolve
   * @param {number} timestamp - The chosen timeline point T, in ms
   * @return {string[]} The resolved base content as a fresh array of lines
   */
  protected static resolveBaseAt(snapshot: FileSnapshot, timestamp: number): string[] {
    const versions: FileVersion[] = Array.isArray(snapshot.versions) ? snapshot.versions : [];

    if (versions.length === 0 && !snapshot.isTombstone()) {
      const lastChanged: number = snapshot.getLastChangedTimestamp();

      if (isNumber(lastChanged) && timestamp >= lastChanged) {
        return snapshot.getLastStateLines();
      }

      return Array.isArray(snapshot.historyLines) ? [...snapshot.historyLines] : [];
    }

    for (let i: number = versions.length - 1; i >= 0; i -= 1) {
      const version: FileVersion = versions[i];

      if (version && isNumber(version.timestamp) && version.timestamp <= timestamp) {
        return version.getLines();
      }
    }

    /**
     * No version captured at or before T: the persisted history baseline is
     * the file's earliest known content from the modal's point of view (see
     * FileSnapshot.adoptHistory on the marker vs. history baseline split).
     */
    return Array.isArray(snapshot.historyLines) ? [...snapshot.historyLines] : [];
  }

  /**
   * Line-by-line equality used to decide `modified` vs `none` for two live
   * states. Cheaper than joining the arrays and comparing strings because the
   * common case (identical) short-circuits on the first mismatching index.
   *
   * @param {string[]} a - First line array
   * @param {string[]} b - Second line array
   * @return {boolean} True when both arrays have the same length and contents
   */
  protected static contentEquals(a: string[], b: string[]): boolean {
    if (a.length !== b.length) {
      return false;
    }

    for (let i: number = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) {
        return false;
      }
    }

    return true;
  }
}
