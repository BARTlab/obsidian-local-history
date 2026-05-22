import { FolderDeltaStatus } from '@/consts';
import type { FileSnapshot } from '@/snapshots/file.snapshot';
import type { FileVersion } from '@/snapshots/file.version';
import { isNumber } from 'lodash-es';

export { FolderDeltaStatus } from '@/consts';

/**
 * Result of comparing a snapshot's state at a chosen timeline point T to its
 * current state (D8). `base` is the resolved content at T (an empty array means
 * "did not exist at T"); `current` is the resolved live content (an empty array
 * means "does not exist now"); `status` is the categorical diff used by the
 * folder tree colouring.
 *
 * The two content arrays are returned as plain copies so the diff renderer can
 * consume them without worrying about mutating the underlying snapshot.
 */
export interface FolderDeltaResult {
  status: FolderDeltaStatus;
  base: string[];
  current: string[];
}

/**
 * Pure helper that resolves the per-file delta from a chosen folder-timeline
 * point T to "now" (D8). Used by the folder modal tree to colour each file by
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

    // The file is gone now and was already gone at T: there is nothing to show
    // on this row for this point in time. The folder tree filters these out.
    if (!existsNow && !existedAtT) {
      return { status: FolderDeltaStatus.none, base: [], current: [] };
    }

    // The file did not exist at T but exists now (created or moved in later).
    // No base content to diff against; the diff renders as "everything green".
    if (!existedAtT) {
      return { status: FolderDeltaStatus.added, base: [], current };
    }

    const base: string[] = FolderDeltaHelper.resolveBaseAt(snapshot, timestamp);

    // The file existed at T and is gone now (a tombstone deleted after T): the
    // diff renders as "everything red" against the base content at T.
    if (!existsNow) {
      return { status: FolderDeltaStatus.deleted, base, current: [] };
    }

    // Both sides exist: an actual line-by-line comparison decides whether the
    // row is `modified` or `none` so the tree skips visually-equal files.
    return {
      status: FolderDeltaHelper.contentEquals(base, current) ? FolderDeltaStatus.none : FolderDeltaStatus.modified,
      base,
      current,
    };
  }

  /**
   * Whether the snapshot represented a file that existed at T. A live snapshot
   * existed at T when its creation `timestamp` is at or before T; a tombstone
   * existed at T when it was deleted strictly AFTER T (`deletedTimestamp > T`).
   * A tombstone whose deletion is at or before T is considered "already gone
   * at T", so the resulting cell is `'none'` rather than `'deleted'`.
   *
   * The same rule applies to move-ins: `movedIntoAt` is not consulted directly
   * because the snapshot's `timestamp` is set at construction time, which is
   * earlier than (or equal to) the move-in stamp on a re-keyed snapshot; the
   * earlier creation time is the correct existence boundary for the file
   * across both folders.
   *
   * @param {FileSnapshot} snapshot - The snapshot under inspection
   * @param {number} timestamp - The chosen timeline point T, in ms
   * @return {boolean} True when the snapshot represented a file present at T
   */
  protected static existedAtT(snapshot: FileSnapshot, timestamp: number): boolean {
    // A snapshot created after T means the file did not exist at T regardless
    // of whether it is currently live or a tombstone.
    if (isNumber(snapshot.timestamp) && snapshot.timestamp > timestamp) {
      return false;
    }

    if (snapshot.isTombstone()) {
      // The tombstone existed at T only when it was deleted strictly after T.
      return isNumber(snapshot.deletedTimestamp) && snapshot.deletedTimestamp > timestamp;
    }

    return true;
  }

  /**
   * Resolves the file's content at T as the captured version whose timestamp
   * is the latest at or before T, falling back to the persisted history
   * baseline when no version qualifies. The snapshot's `versions` array is
   * stored oldest-first (by capture order), so scanning back from the end
   * finds the qualifying version in one pass.
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

    for (let i: number = versions.length - 1; i >= 0; i -= 1) {
      const version: FileVersion = versions[i];

      if (version && isNumber(version.timestamp) && version.timestamp <= timestamp) {
        return version.getLines();
      }
    }

    // No version captured at or before T: the persisted history baseline is
    // the file's earliest known content from the modal's point of view (see
    // FileSnapshot.adoptHistory / D2 on the marker vs. history baseline split).
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
