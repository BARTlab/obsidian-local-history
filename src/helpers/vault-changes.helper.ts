import { FolderDeltaStatus } from '@/consts';
import type { FileSnapshot } from '@/snapshots/file.snapshot';
import type { FileVersion } from '@/snapshots/file.version';
import type { FolderTreeEntry } from '@/types';

/**
 * Pure helper that classifies every tracked snapshot by its status relative to
 * the RESOLVED origin (see `resolveOrigin`), the single baseline every change
 * STATUS surface diffs against. This is the vault-wide changes panel's scope: a
 * file shows up when its current content still differs from that origin, or when
 * it was born under tracking, or when it was deleted (a tombstone). Because the
 * origin is the same one the change map (and therefore the tree, gutter and tab
 * decorators) diffs against, the panel and the tree list exactly the same
 * changed set at every `keep` level - at `keep=persist` bounded by retention as
 * the origin slides, at `keep=file`/`app` the session marker baseline. Unlike
 * `SessionStatusHelper` (session-scoped, `added | modified | none`, deletes
 * dropped), this survives an app restart at `keep=persist` and it DOES surface
 * `deleted`.
 *
 * The origin is supplied by the caller (a pre-resolved line array for
 * `statusOf`, a per-snapshot resolver for `collectEntries`) so this helper never
 * imports the resolver or any service and stays pure: coarse, derived from the
 * snapshot plus the origin alone (no vault, no DOM), cheap to call per snapshot
 * on every panel refresh, and trivially unit-testable.
 */

/**
 * Whether a line array carries no real content: either empty, or a single empty
 * line (how a blank file decomposes). Used to tell "born under tracking" (an
 * empty origin that now has content) apart from an ordinary edit.
 *
 * @param {string[]} lines - The line array to test
 * @return {boolean} True when the array holds no content
 */
function isBlankContent(lines: string[]): boolean {
  return lines.length === 0 || (lines.length === 1 && lines[0] === '');
}

/**
 * Line-by-line equality, short-circuiting on the first mismatch. Cheaper than
 * joining both sides into strings for the common identical case.
 *
 * @param {string[]} a - First line array
 * @param {string[]} b - Second line array
 * @return {boolean} True when both arrays have the same length and contents
 */
function contentEquals(a: string[], b: string[]): boolean {
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
 * Whether the file's newest captured version came from an off-editor (external)
 * change, so the panel row can carry the external badge, matching the folder
 * modal tree. `getVersions()` is newest-first, so the head is the latest point;
 * a file with no captured versions carries no badge.
 *
 * @param {FileSnapshot} snapshot - The snapshot whose latest version to inspect
 * @return {boolean} True when the newest version is an external capture
 */
function latestIsExternal(snapshot: FileSnapshot): boolean {
  const versions: FileVersion[] = snapshot.timeline.getVersions();

  return versions.length > 0 && versions[0].isExternal();
}

/**
 * Resolves the status of a single snapshot against the supplied origin. Pure and
 * total: it never throws and never touches anything outside the snapshot and the
 * origin, so a caller iterating a possibly-stale map can pass any live or
 * tombstone snapshot.
 *
 * Precedence: `deleted` (a tombstone) wins first; then `added` for a file born
 * under tracking (created this run, or an empty origin that now has content);
 * then `modified` when the current content diverges from the origin; otherwise
 * `none` (unchanged since the origin, so the panel hides it).
 *
 * @param {FileSnapshot} snapshot - The snapshot to classify (live or tombstone)
 * @param {string[]} origin - The resolved baseline lines to diff the current
 *   content against (from `resolveOrigin` at the caller)
 * @return {FolderDeltaStatus} One of `deleted`, `added`, `modified`, or `none`
 */
export function statusOf(snapshot: FileSnapshot, origin: string[]): FolderDeltaStatus {
  if (snapshot.isTombstone()) {
    return FolderDeltaStatus.deleted;
  }

  const current: string[] = snapshot.content.getLastStateLines();

  if (snapshot.createdThisSession || (isBlankContent(origin) && !isBlankContent(current))) {
    return FolderDeltaStatus.added;
  }

  if (!contentEquals(origin, current)) {
    return FolderDeltaStatus.modified;
  }

  return FolderDeltaStatus.none;
}

/**
 * Maps a snapshot list into the `FolderTreeEntry[]` the changes panel feeds to
 * `FolderTreeComponent`. Each snapshot resolves to its status against the origin
 * `resolveOrigin` returns for it; `none` snapshots (unchanged since their origin)
 * are dropped so the panel shows only files that actually changed. The path is
 * resolved without a live `TFile` (`file?.path ?? path`) so a restored or
 * tombstoned snapshot still contributes its row after a reload.
 *
 * The `resolveOrigin` callback carries the `keep`-aware baseline choice in from
 * the caller so this pure helper agrees with every other status surface (the
 * tree, gutter and tabs, which follow the same origin through the change map)
 * without importing the resolver or any service.
 *
 * The optional `include` predicate lets the caller drop paths hidden by a
 * visibility filter (our own exclude patterns, Obsidian's "Excluded files")
 * without coupling this pure helper to those services; it defaults to
 * include-all so tests and simple callers can ignore it.
 *
 * @param {Iterable<FileSnapshot>} snapshots - The tracked snapshots to classify
 * @param {(snapshot: FileSnapshot) => string[]} resolveOrigin - Per-snapshot
 *   baseline resolver (the caller binds `keep`), diffed against current content
 * @param {(path: string) => boolean} [include] - Optional path visibility gate
 * @return {FolderTreeEntry[]} The changed-file entries (status never `none`)
 */
export function collectEntries(
  snapshots: Iterable<FileSnapshot>,
  resolveOrigin: (snapshot: FileSnapshot) => string[],
  include?: (path: string) => boolean,
): FolderTreeEntry[] {
  const entries: FolderTreeEntry[] = [];

  for (const snapshot of snapshots) {
    const path: string = snapshot.file?.path ?? snapshot.path;

    if (!path || (include && !include(path))) {
      continue;
    }

    const status: FolderDeltaStatus = statusOf(snapshot, resolveOrigin(snapshot));

    if (status === FolderDeltaStatus.none) {
      continue;
    }

    entries.push({
      path,
      status,
      external: latestIsExternal(snapshot),
      date: snapshot.getLastChangedDateTime(),
    });
  }

  return entries;
}
