import { FolderTimelinePointKind } from '@/consts';
import type { FileSnapshot } from '@/snapshots/file.snapshot';
import type { FolderTimelinePoint } from '@/types';

export { FolderTimelinePointKind } from '@/consts';

/**
 * Pure helper that synthesises a folder-level history timeline from the per-file
 * snapshots living under a folder root. The plugin never persists folder
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

/**
 * Synthesises the folder timeline from the snapshots whose path starts with
 * `rootPath`. See the module docs for the kinds emitted and the ordering
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
export function synthesize(snapshots: Iterable<FileSnapshot>, rootPath: string): FolderTimelinePoint[] {
  if (!snapshots) {
    return [];
  }

  const normalizedRoot: string = normalizeRoot(rootPath);
  const points: FolderTimelinePoint[] = [];

  for (const snapshot of snapshots) {
    if (!snapshot) {
      continue;
    }

    const path: string = pathOf(snapshot);

    if (!isUnderRoot(path, normalizedRoot)) {
      continue;
    }

    /**
     * Capture points come from the version timeline, in stored order so a
     * tie on timestamp keeps the original sequence the snapshot recorded. The
     * `?? []` guards a malformed snapshot (e.g. a missing history shard left the
     * timeline unpopulated) so a bad entry is skipped rather than crashing the
     * whole rail.
     */
    for (const version of snapshot.timeline?.getStoredVersions?.() ?? []) {
      points.push({
        timestamp: version.timestamp,
        path,
        kind: FolderTimelinePointKind.capture,
        dayKey: dayKeyOf(version.timestamp),
        versionId: version.id,
      });
    }

    if (snapshot.isTombstone() && typeof snapshot.deletedTimestamp === 'number') {
      points.push({
        timestamp: snapshot.deletedTimestamp,
        path,
        kind: FolderTimelinePointKind.delete,
        dayKey: dayKeyOf(snapshot.deletedTimestamp),
      });
    }

    if (snapshot.isMovedIn() && typeof snapshot.movedIntoAt === 'number') {
      points.push({
        timestamp: snapshot.movedIntoAt,
        path,
        kind: FolderTimelinePointKind.moveIn,
        dayKey: dayKeyOf(snapshot.movedIntoAt),
      });
    }

    const originPoint: FolderTimelinePoint | null = unversionedOriginPoint(snapshot, path);

    if (originPoint) {
      points.push(originPoint);
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
 * Synthesises a single ORIGIN point for a live snapshot that has changed since
 * its history baseline but captured no intermediate version yet. Such a file is
 * invisible to the version / tombstone / move points above, so a folder holding
 * only that file would open an empty modal (no rail, an all-`none` tree) even
 * though the file genuinely changed - the same whole-history change the
 * vault-changes panel already surfaces (see VaultChangesHelper.statusOf). One
 * synthetic point gives the modal a selectable T at which FolderDeltaHelper.compareAt
 * resolves the baseline as the "before" side, so the tree row and diff appear.
 *
 * Returns null when the file has captured versions (the real points already
 * cover it), is a tombstone or a move-in (their own points exist), or is
 * unchanged since its origin (nothing to show).
 *
 * The point's timestamp decides the delta status `compareAt` reports:
 * - A file born under tracking (blank origin) reads as `added`, so the point
 *   sits strictly BEFORE the file's first-seen instant (existed-at-T is false).
 * - A pre-existing file edited below the capture cadence reads as `modified`,
 *   so the point sits at/after first-seen but strictly BEFORE the last change,
 *   the window in which `resolveBaseAt` hands back the history baseline rather
 *   than the live state.
 *
 * @param {FileSnapshot} snapshot - The snapshot to inspect (live or tombstone)
 * @param {string} path - The snapshot's resolved vault-relative path
 * @return {FolderTimelinePoint | null} The synthetic origin point, or null
 */
function unversionedOriginPoint(snapshot: FileSnapshot, path: string): FolderTimelinePoint | null {
  if (snapshot.isTombstone() || snapshot.isMovedIn()) {
    return null;
  }

  // Defensive: a partially-loaded snapshot (missing history shard) can lack its
  // content or timeline sub-objects; skip it rather than throw inside synthesize.
  if (!snapshot.content || !snapshot.timeline) {
    return null;
  }

  if (snapshot.timeline.getStoredVersions().length > 0) {
    return null;
  }

  const origin: string[] = snapshot.content.getHistoryOriginalStateLines();
  const current: string[] = snapshot.content.getLastStateLines();

  if (linesEqual(origin, current)) {
    return null;
  }

  const firstSeen: number = typeof snapshot.timestamp === 'number'
    ? snapshot.timestamp
    : snapshot.getLastChangedTimestamp();

  const lastChanged: number = snapshot.getLastChangedTimestamp();

  const timestamp: number = isBlankLines(origin)
    ? firstSeen - 1
    : Math.min(firstSeen, lastChanged - 1);

  return {
    timestamp,
    path,
    kind: FolderTimelinePointKind.capture,
    dayKey: dayKeyOf(timestamp),
  };
}

/**
 * Whether a line array carries no real content: empty, or a single empty line
 * (how a blank file decomposes). Mirrors `VaultChangesHelper.isBlankContent` so
 * a file born under tracking is told apart from an ordinary edit.
 *
 * @param {string[]} lines - The line array to test
 * @return {boolean} True when the array holds no content
 */
function isBlankLines(lines: string[]): boolean {
  return lines.length === 0 || (lines.length === 1 && lines[0] === '');
}

/**
 * Line-by-line equality, short-circuiting on the first mismatch. Cheaper than
 * joining both sides for the common identical case.
 *
 * @param {string[]} a - First line array
 * @param {string[]} b - Second line array
 * @return {boolean} True when both arrays have the same length and contents
 */
function linesEqual(a: string[], b: string[]): boolean {
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

/**
 * Returns the day-group key for a timestamp the same way {@link FileVersion.getDate}
 * does, so a folder modal rail using the same string can match a file modal
 * rail group heading for any version on the same calendar day.
 *
 * @param {number} timestamp - Capture timestamp in milliseconds
 * @return {string} Localized day key, identical to `new Date(ts).toLocaleDateString()`
 */
export function dayKeyOf(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString();
}

/**
 * Resolves the vault-relative path of a snapshot. Prefers the attached
 * `file.path` (live snapshots own a `TFile`), and falls back to the
 * snapshot's carried `path`, which mirrors the canonical map key in
 * `SnapshotsService.fileSnapshots`. The fallback is what keeps a restored
 * snapshot whose `file` did not resolve (restore miss, detached tombstone or
 * orphan) on the timeline after a reload, instead of being dropped by an empty
 * path.
 *
 * A snapshot without any usable path (defensive: not expected in practice)
 * contributes nothing to the timeline.
 *
 * @param {FileSnapshot} snapshot - The snapshot to inspect
 * @return {string} The vault-relative path, or `''` when missing
 */
function pathOf(snapshot: FileSnapshot): string {
  return snapshot?.file?.path ?? snapshot?.path ?? '';
}

/**
 * Strips a trailing slash from the root prefix so the matcher does not have
 * to special-case it. An empty root matches every path (whole-vault scope).
 *
 * @param {string} rootPath - Caller-supplied folder root
 * @return {string} Normalized root, never ending in a slash
 */
function normalizeRoot(rootPath: string): string {
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
function isUnderRoot(path: string, root: string): boolean {
  if (!path) {
    return false;
  }

  if (!root) {
    return true;
  }

  return path === root || path.startsWith(`${root}/`);
}
