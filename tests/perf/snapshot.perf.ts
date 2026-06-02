import {describe, expect, it} from '@jest/globals';

import type {SnapshotCaptureOptions} from '@/types';

import {
  buildEditedSnapshot,
  buildLines,
  buildSnapshot,
  buildVersionedSnapshot,
  FIXTURE_SIZES,
  OPEN_CAPTURE_OPTIONS,
} from './fixtures/snapshot-fixture';
import {assertWithinBaseline, measure} from './harness';

/**
 * Perf benches for the FileSnapshot hot paths (T03). Each bench drives only the
 * public FileSnapshot API, records a median over a fixed iteration count under a
 * `snapshot.<method>.<size>` label, and gates the median against the committed
 * baseline. Against an empty baseline the gate records-only (no throw); against
 * a populated one it fails past the regression budget. Runs node-env, DOM-free.
 *
 * Each fn is shaped to keep the snapshot in a steady state across iterations so
 * repeated measurement does not drift the input out from under the bench:
 *   - updateChanges is idempotent (recomputes from the fixed tracker each call).
 *   - shift walks up then back down over the same range, leaving positions put.
 *   - captureVersion replays a no-op (dedup-hit) so the timeline length is fixed
 *     while the isDuplicateOfLatest compare path is exercised every call.
 *   - evictVersions pushes one fresh forced version into a cap-sized timeline so
 *     exactly one entry is evicted, holding the length constant.
 */
describe('snapshot perf', () => {
  const medium = FIXTURE_SIZES.medium;
  const large = FIXTURE_SIZES.large;

  it('updateChanges over the medium fixture', () => {
    const label = `snapshot.updateChanges.${medium.name}`;
    const snapshot = buildEditedSnapshot(medium);

    const median = measure(label, () => {
      snapshot.updateChanges();
    }, 100);

    expect(median).toBeGreaterThan(0);
    assertWithinBaseline(label, median);
  });

  it('shiftUp/shiftDown over the medium fixture', () => {
    const label = `snapshot.shift.${medium.name}`;
    const snapshot = buildSnapshot(medium);
    const last = medium.lines - 1;

    const median = measure(label, () => {
      // Walk the whole tracker range up by one then back down by one, so the
      // current positions return to their start and the next iteration measures
      // the same O(T) walk rather than a drifted one.
      snapshot.shiftUp(0, last);
      snapshot.shiftDown(0, last + 1);
    }, 100);

    expect(median).toBeGreaterThan(0);
    assertWithinBaseline(label, median);
  });

  it('captureVersion + isDuplicateOfLatest over the medium fixture', () => {
    const label = `snapshot.captureVersion.${medium.name}`;
    const snapshot = buildVersionedSnapshot(medium);

    // The content that equals the newest stored version: replaying it makes
    // every capture take the cadence path (editThreshold 1) and then hit the
    // isDuplicateOfLatest compare, which returns null without pushing, so the
    // timeline length is fixed while the dedup compare is measured each call.
    const latest = snapshot.getVersions()[0];
    const duplicate = latest.lines.slice();
    const before = snapshot.getVersions().length;

    const median = measure(label, () => {
      snapshot.captureVersion(duplicate, OPEN_CAPTURE_OPTIONS, false);
    }, 100);

    expect(median).toBeGreaterThan(0);
    expect(snapshot.getVersions().length).toBe(before);
    assertWithinBaseline(label, median);
  });

  it('evictVersions after a push over the large fixture', () => {
    const label = `snapshot.evictVersions.${large.name}`;
    const snapshot = buildVersionedSnapshot(large);

    // Cap the timeline at exactly its loaded size so each forced push of a fresh
    // version overflows by one and evictVersions drops a single oldest entry,
    // holding the length constant across iterations while the two eviction
    // passes (age filter then count filter) run on a full-size array each call.
    const capped: SnapshotCaptureOptions = {...OPEN_CAPTURE_OPTIONS, maxVersions: large.versions};
    const before = snapshot.getVersions().length;
    const body = buildLines(large.lines);
    let counter = 0;

    const median = measure(label, () => {
      const fresh = body.slice();
      fresh[0] = `evict probe ${counter++}`;
      snapshot.captureVersion(fresh, capped, true);
    }, 100);

    expect(median).toBeGreaterThan(0);
    expect(snapshot.getVersions().length).toBe(before);
    assertWithinBaseline(label, median);
  });
});
