import { FolderDeltaStatus } from '@/consts';
import type { FileSnapshot } from '@/snapshots/file.snapshot';

export { FolderDeltaStatus } from '@/consts';

/**
 * Pure helper that maps a single snapshot to its CHANGE STATUS for the current
 * app session (epic 11). It is the one place the native tree/tab decorator asks
 * "what colour is this file right now?", mirroring the static-only shape of the
 * other `src/helpers/*` helpers (no vault, no DOM, no Obsidian state).
 *
 * The feature paints only native surfaces (file rows, ancestor folders, tab
 * headers), which exist solely for files that are present in the vault, so the
 * status space is intentionally narrowed to the `added | modified | none`
 * members of the existing {@link FolderDeltaStatus} enum. `deleted` is out of
 * scope (D5): a deleted file has no native row and no tab, so there is nothing
 * to paint, and a tombstoned snapshot therefore resolves to `none` rather than
 * `deleted` (deletes stay in the diff modal via `FolderDeltaHelper`).
 *
 * The session signals, in precedence order `added > modified > none`:
 *
 * - `added` - the transient `createdThisSession` flag (D4), stamped by the
 *   post-layout-ready `vault.create` capture path. It is the only reliable
 *   "created this run" signal and is never persisted, so a snapshot restored
 *   from history after a restart comes back as `none`/`modified` and stops
 *   being painted green.
 * - `modified` - `getChangesLinesCount() > 0` against the marker baseline, the
 *   exact change set the gutter paints (D1), so the tree and the gutter agree
 *   by construction.
 * - `none` - nothing changed this session worth painting on a native surface.
 *
 * `added` wins over `modified` because a file created this session that has
 * since been edited is still "new this session" to the user; the green
 * created-now read is the more informative one for a brand-new file.
 */
export class SessionStatusHelper {
  /**
   * Resolves the session change status of a single snapshot. Pure and total:
   * it never throws and never touches anything outside the snapshot, so callers
   * iterating a possibly-stale map can pass any live or tombstone snapshot.
   *
   * @param {FileSnapshot} snapshot - The snapshot to classify (live or tombstone)
   * @return {FolderDeltaStatus} One of `added`, `modified`, or `none`
   */
  public static statusOf(snapshot: FileSnapshot): FolderDeltaStatus {
    /**
     * A tombstone has no native row or tab to paint, so it is `none` (D5),
     * even if it was created and then deleted in the same session.
     */
    if (snapshot.isTombstone()) {
      return FolderDeltaStatus.none;
    }

    /**
     * `added` takes precedence over `modified`: a file created this session is
     * surfaced as new even after subsequent edits.
     */
    if (snapshot.createdThisSession) {
      return FolderDeltaStatus.added;
    }

    if (snapshot.getChangesLinesCount() > 0) {
      return FolderDeltaStatus.modified;
    }

    return FolderDeltaStatus.none;
  }
}
