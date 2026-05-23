import { FolderTimelinePointKind } from '@/consts';
import type { FileSnapshot } from '@/snapshots/file.snapshot';
import { isNumber } from 'lodash-es';

export { FolderTimelinePointKind } from '@/consts';

/**
 * A single point in the folder timeline. `timestamp` is the moment the event
 * happened (newest-first when sorted), `path` is the snapshot's vault-relative
 * path under the folder root, `kind` is the discriminator above, and `dayKey`
 * is the localized day string (`new Date(timestamp).toLocaleDateString()`) the
 * rail uses to group rows: identical to {@link FileVersion.getDate} so the
 * folder modal rail can group rows the same way the file modal rail does.
 *
 * For a `'capture'` point, `versionId` carries the originating version's id
 * so callers can correlate the timeline entry with the underlying
 * {@link FileVersion}. For `'delete'` and `'move-in'` points, the field stays
 * `undefined` (the event is a snapshot-level marker, not tied to a version).
 */
export interface FolderTimelinePoint {
  timestamp: number;
  path: string;
  kind: FolderTimelinePointKind;
  dayKey: string;
  versionId?: string;
}

/**
 * Pure helper that synthesises a folder-level history timeline from the per-file
 * snapshots living under a folder root (D7). The plugin never persists folder
 * events; instead every fact the folder modal needs is derived on demand from
 * the snapshots in the {@link SnapshotsService} map:
 *
 * - every {@link FileVersion} contributes a `'capture'` point at its timestamp,
 * - every tombstone (`isTombstone()`) contributes a `'delete'` point at its
 *   `deletedTimestamp`,
 * - every move-in (`isMovedIn()`) contributes a `'move-in'` point at its
 *   `movedIntoAt`.
 *
 * Points outside the subtree (path does not start with `rootPath`) are skipped.
 * The result is sorted newest-first; ties keep their insertion order so the
 * day-group rendering is deterministic across runs (the `Array.prototype.sort`
 * spec guarantees stability under V8, which Obsidian runs on).
 *
 * The helper is stateless and has no Obsidian dependency: it accepts a plain
 * iterable of snapshots so callers can pass `SnapshotsService.getList()`, an
 * `ObservableMap.values()`, or any unit-test fixture without adaptation.
 */
export class FolderTimelineHelper {
  /**
   * Synthesises the folder timeline from the snapshots whose path starts with
   * `rootPath`. See the class docs for the kinds emitted and the ordering
   * contract; see {@link FolderTimelinePoint} for the per-point shape.
   *
   * An empty input or an empty subtree returns an empty array. A `rootPath`
   * of `''` matches every snapshot, which is the natural "whole vault" case
   * a future caller could use; today the folder modal always passes a real
   * folder path.
   *
   * @param {Iterable<FileSnapshot>} snapshots - The snapshots to scan
   * @param {string} rootPath - Vault-relative folder path (no trailing slash)
   * @return {FolderTimelinePoint[]} Points sorted newest-first, stable on ties
   */
  public static synthesize(snapshots: Iterable<FileSnapshot>, rootPath: string): FolderTimelinePoint[] {
    if (!snapshots) {
      return [];
    }

    const normalizedRoot: string = FolderTimelineHelper.normalizeRoot(rootPath);
    const points: FolderTimelinePoint[] = [];

    for (const snapshot of snapshots) {
      if (!snapshot) {
        continue;
      }

      const path: string = FolderTimelineHelper.pathOf(snapshot);

      if (!FolderTimelineHelper.isUnderRoot(path, normalizedRoot)) {
        continue;
      }

      /**
       * Capture points come from the version timeline, in stored order so a
       * tie on timestamp keeps the original sequence the snapshot recorded.
       */
      for (const version of snapshot.versions ?? []) {
        points.push({
          timestamp: version.timestamp,
          path,
          kind: FolderTimelinePointKind.capture,
          dayKey: FolderTimelineHelper.dayKeyOf(version.timestamp),
          versionId: version.id,
        });
      }

      if (snapshot.isTombstone() && isNumber(snapshot.deletedTimestamp)) {
        points.push({
          timestamp: snapshot.deletedTimestamp,
          path,
          kind: FolderTimelinePointKind.delete,
          dayKey: FolderTimelineHelper.dayKeyOf(snapshot.deletedTimestamp),
        });
      }

      if (snapshot.isMovedIn() && isNumber(snapshot.movedIntoAt)) {
        points.push({
          timestamp: snapshot.movedIntoAt,
          path,
          kind: FolderTimelinePointKind.moveIn,
          dayKey: FolderTimelineHelper.dayKeyOf(snapshot.movedIntoAt),
        });
      }
    }

    /**
     * Newest first, ties preserve insertion order. V8's Array.prototype.sort
     * is stable, so a comparator returning 0 keeps the original sequence.
     */
    points.sort(
      (a: FolderTimelinePoint, b: FolderTimelinePoint): number => b.timestamp - a.timestamp,
    );

    return points;
  }

  /**
   * Returns the day-group key for a timestamp the same way {@link FileVersion.getDate}
   * does, so a folder modal rail using the same string can match a file modal
   * rail group heading for any version on the same calendar day.
   *
   * @param {number} timestamp - Capture timestamp in milliseconds
   * @return {string} Localized day key, identical to `new Date(ts).toLocaleDateString()`
   */
  public static dayKeyOf(timestamp: number): string {
    return new Date(timestamp).toLocaleDateString();
  }

  /**
   * Resolves the vault-relative path of a snapshot. Prefers the attached
   * `file.path` (live snapshots own a `TFile`), and falls back to scanning the
   * map key out of `file?.path` only - tombstones built by `markDeleted`/`markMoved`
   * keep their pre-delete `TFile` reference, so the path stays correct without
   * the caller having to pass the map key separately.
   *
   * A snapshot without any usable path (defensive: not expected in practice)
   * contributes nothing to the timeline.
   *
   * @param {FileSnapshot} snapshot - The snapshot to inspect
   * @return {string} The vault-relative path, or `''` when missing
   */
  protected static pathOf(snapshot: FileSnapshot): string {
    return snapshot?.file?.path ?? '';
  }

  /**
   * Strips a trailing slash from the root prefix so the matcher does not have
   * to special-case it. An empty root matches every path (whole-vault scope).
   *
   * @param {string} rootPath - Caller-supplied folder root
   * @return {string} Normalized root, never ending in a slash
   */
  protected static normalizeRoot(rootPath: string): string {
    if (!rootPath) {
      return '';
    }

    return rootPath.endsWith('/') ? rootPath.slice(0, -1) : rootPath;
  }

  /**
   * Whether the given path is inside the root prefix. An empty root matches
   * everything; an exact equality match is allowed (a snapshot keyed exactly at
   * the root path is a degenerate but harmless case); otherwise the path must
   * have `${root}/` as its prefix so `src/a.md` does not match the root `s`.
   *
   * @param {string} path - Vault-relative path to test
   * @param {string} root - Normalized root prefix (no trailing slash)
   * @return {boolean} True when `path` lives under `root`
   */
  protected static isUnderRoot(path: string, root: string): boolean {
    if (!path) {
      return false;
    }

    if (!root) {
      return true;
    }

    return path === root || path.startsWith(`${root}/`);
  }
}
