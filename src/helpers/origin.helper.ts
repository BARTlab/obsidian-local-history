import { KeepHistory } from '@/consts';
import type { FileSnapshot } from '@/snapshots/file.snapshot';

/**
 * Pure resolver for a file's "original": the single baseline every change STATUS
 * surface diffs the live content against. The origin depends only on the `keep`
 * durability level and the data already on the snapshot, so no vault, DOM, or
 * Obsidian API is touched and the function is trivially unit-testable, mirroring
 * the stateless shape of the other `src/helpers/*` helpers.
 *
 * - `keep=file`/`app` resolve to the session MARKER baseline
 *   (`content.getOriginalStateLines()`), the origin the gutter measures against
 *   for the running session. Versions are irrelevant at these levels.
 * - `keep=persist` resolves to the SLIDING origin: the oldest retained version's
 *   lines, falling back to the HISTORY baseline
 *   (`content.getHistoryOriginalStateLines()`) only when the timeline is empty.
 *   Because retention evicts old versions from the front of the timeline, the
 *   origin slides forward and the change set stays bounded by the retention caps
 *   the user already sets, rather than growing to everything-since-day-one. A
 *   labeled (pinned) oldest version anchors an arbitrarily old origin, so the
 *   bound is approximate but always well-defined.
 *
 * Every branch returns a fresh array (each accessor copies), so callers can
 * neither mutate the snapshot's state nor throw.
 *
 * @param {FileSnapshot} snapshot - The snapshot to resolve the origin for
 * @param {KeepHistory} keep - The durability level driving the origin choice
 * @return {string[]} The baseline lines the file is diffed against
 */
export function resolveOrigin(snapshot: FileSnapshot, keep: KeepHistory): string[] {
  if (keep === KeepHistory.persist) {
    return snapshot.getOldestRetainedLines() ?? snapshot.content.getHistoryOriginalStateLines();
  }

  return snapshot.content.getOriginalStateLines();
}
