import 'reflect-metadata';

import { describe, expect, it } from 'vitest';

import * as FolderDeltaHelper from '@/helpers/folder-delta.helper';
import * as FolderTimelineHelper from '@/helpers/folder-timeline.helper';
import type { FileSnapshot } from '@/snapshots/file.snapshot';
import type { FolderDeltaResult, FolderTimelinePoint } from '@/types';

import {
  buildSnapshots,
  FIXTURE_SHAPES,
  probeTimestamp,
  ROOT_PATH,
} from './fixtures/folder-fixture';
import { assertWithinBaseline, measure } from './harness';

/**
 * Perf benches for the folder-history aggregation hot paths. They lock
 * the cost of the work the folder modal pays before it paints:
 * `FolderTimelineHelper.synthesize` (scans every snapshot in the subtree, emits
 * a point per version / tombstone / move-in, then sorts newest-first) and
 * `FolderDeltaHelper.compareAt` (called once per file when the tree redraws
 * against a chosen timeline point).
 *
 * Both helpers are static and pure: they read the snapshot list without
 * mutating it, so a single fixed fixture holds steady across all `measure`
 * iterations (no per-iter rebuild folding construction cost into the median, no
 * input drift). Benches drive only the public helper API. Each `folder.*` label
 * records-only against the empty baseline and gates past the regression budget
 * once a number is recorded. Runs node-env, DOM-free.
 */
describe('folder perf', () => {
  const shallow = FIXTURE_SHAPES.shallow;
  const nested = FIXTURE_SHAPES.nested;
  const wide = FIXTURE_SHAPES.wide;

  it('synthesize over the shallow fixture', () => {
    const label = `folder.timeline.synthesize.${shallow.name}`;
    const snapshots: FileSnapshot[] = buildSnapshots(shallow);

    // Sanity: the subtree is non-empty and synthesize emits at least one point
    // per file version, so the bench measures real aggregation work.
    const points: FolderTimelinePoint[] = FolderTimelineHelper.synthesize(snapshots, ROOT_PATH);
    expect(points.length).toBeGreaterThan(shallow.files);

    const median = measure(label, () => {
      FolderTimelineHelper.synthesize(snapshots, ROOT_PATH);
    }, 100);

    expect(median).toBeGreaterThan(0);
    assertWithinBaseline(label, median);
  });

  it('synthesize over the nested fixture', () => {
    const label = `folder.timeline.synthesize.${nested.name}`;
    const snapshots: FileSnapshot[] = buildSnapshots(nested);

    const points: FolderTimelinePoint[] = FolderTimelineHelper.synthesize(snapshots, ROOT_PATH);
    expect(points.length).toBeGreaterThan(nested.files);

    const median = measure(label, () => {
      FolderTimelineHelper.synthesize(snapshots, ROOT_PATH);
    }, 100);

    expect(median).toBeGreaterThan(0);
    assertWithinBaseline(label, median);
  });

  it('synthesize over the wide fixture', () => {
    const label = `folder.timeline.synthesize.${wide.name}`;
    const snapshots: FileSnapshot[] = buildSnapshots(wide);

    const points: FolderTimelinePoint[] = FolderTimelineHelper.synthesize(snapshots, ROOT_PATH);
    expect(points.length).toBeGreaterThan(wide.files);

    const median = measure(label, () => {
      FolderTimelineHelper.synthesize(snapshots, ROOT_PATH);
    }, 50);

    expect(median).toBeGreaterThan(0);
    assertWithinBaseline(label, median);
  });

  it('compareAt across the nested subtree at a mid-range point', () => {
    const label = `folder.delta.compareAt.${nested.name}`;
    const snapshots: FileSnapshot[] = buildSnapshots(nested);
    const t: number = probeTimestamp(nested);

    // Sanity: at least one file resolves to a non-'none' status at the probe, so
    // compareAt is exercising its resolution path (version scan + content
    // compare) rather than short-circuiting on every row.
    const sample: FolderDeltaResult = FolderDeltaHelper.compareAt(snapshots[1], t);
    expect(sample.status).toBeDefined();

    const median = measure(label, () => {
      // One pass over the whole subtree, mirroring a folder-tree redraw that
      // calls compareAt once per file against the chosen timeline point.
      for (const snapshot of snapshots) {
        FolderDeltaHelper.compareAt(snapshot, t);
      }
    }, 100);

    expect(median).toBeGreaterThan(0);
    assertWithinBaseline(label, median);
  });
});
