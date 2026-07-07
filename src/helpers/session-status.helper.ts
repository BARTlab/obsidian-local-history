import { FolderDeltaStatus } from '@/consts';
import type { FileSnapshot } from '@/snapshots/file.snapshot';

/**
 * Pure helper that maps a single snapshot to its CHANGE STATUS for the current
 * app session. It is the one place the native tree/tab decorator asks
 * "what colour is this file right now?", mirroring the stateless shape of the
 * other `src/helpers/*` helpers (no vault, no DOM, no Obsidian state).
 *
 * The feature paints only native surfaces (file rows, ancestor folders, tab
 * headers), which exist solely for files that are present in the vault, so the
 * status space is intentionally narrowed to the `added | modified | none`
 * members of the existing {@link FolderDeltaStatus} enum. `deleted` is out of
 * scope: a deleted file has no native row and no tab, so there is nothing
 * to paint, and a tombstoned snapshot therefore resolves to `none` rather than
 * `deleted` (deletes stay in the diff modal via `FolderDeltaHelper`).
 *
 * The session signals, in precedence order `added > modified > none`:
 *
 * - `added` - the transient `createdThisSession` flag, stamped by the
 *   post-layout-ready `vault.create` capture path. It is the only reliable
 *   "created this run" signal and is never persisted, so a snapshot restored
 *   from history after a restart comes back falsy and stops being painted green.
 * - `modified` - `getChangesLinesCount() > 0` against the marker baseline, the
 *   exact change set the gutter paints, so the tree and the gutter agree
 *   by construction. The marker baseline is the resolved origin: at `keep=persist`
 *   the restore path diff-seeds it from the sliding origin (see
 *   `FileSnapshot.seedTrackerFromOrigin`), so a restored file reports its
 *   changes-vs-origin and the tree paints it after a reload, bounded by retention;
 *   at `keep=file`/`app` the baseline is session-scoped (never restored), so those
 *   modes read `none` on a fresh launch, consistently for root and nested files.
 * - `none` - nothing changed this session worth painting on a native surface.
 *
 * `added` wins over `modified` because a file created this session that has
 * since been edited is still "new this session" to the user; the green
 * created-now read is the more informative one for a brand-new file.
 */

/**
 * Resolves the session change status of a single snapshot. Pure and total:
 * it never throws and never touches anything outside the snapshot, so callers
 * iterating a possibly-stale map can pass any live or tombstone snapshot.
 *
 * @param {FileSnapshot} snapshot - The snapshot to classify (live or tombstone)
 * @return {FolderDeltaStatus} One of `added`, `modified`, or `none`
 */
export function statusOf(snapshot: FileSnapshot): FolderDeltaStatus {
  /**
   * A tombstone has no native row or tab to paint, so it is `none`,
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

  if (snapshot.content.getChangesLinesCount() > 0) {
    return FolderDeltaStatus.modified;
  }

  return FolderDeltaStatus.none;
}

/**
 * Collects every ancestor folder path of the given changed file paths, so the
 * decorator can tint each containing folder a single change colour. Pure
 * and total: it walks the `/`-separated path of each file upward, emitting one
 * entry per intermediate folder and stopping at the vault root, which has no
 * folder row to paint and is therefore never included.
 *
 * For `a/b/c.md` it yields `a` and `a/b`; the set deduplicates folders shared
 * by sibling files, so a folder appears once regardless of how many changed
 * descendants it has.
 *
 * @param {Iterable<string>} changedPaths - Vault paths of changed files
 * @return {Set<string>} The set of ancestor folder paths to tint
 */
export function ancestorFolderPaths(changedPaths: Iterable<string>): Set<string> {
  const folders: Set<string> = new Set();

  for (const path of changedPaths) {
    const parts: string[] = path.split('/');

    /**
     * Drop the file segment itself, then accumulate each folder prefix. The
     * last prefix (the file's immediate parent) and every prefix above it are
     * containing folders; an empty or single-segment path has no parent folder.
     */
    let prefix: string = '';

    for (let i: number = 0; i < parts.length - 1; i++) {
      prefix = prefix ? `${prefix}/${parts[i]}` : parts[i];
      folders.add(prefix);
    }
  }

  return folders;
}
