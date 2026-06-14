import 'reflect-metadata';

import { describe, expect, it } from '@jest/globals';

import { PersistenceService } from '@/services/persistence.service';
import { SnapshotsService } from '@/services/snapshots.service';
import type { SerializedFileSnapshot, SerializedHistory } from '@/types';

import {
  buildPluginStub,
  buildSerializedHistory,
  buildSerializedSnapshots,
  FIXTURE_SIZES,
  OPEN_RETENTION,
  type PluginStub,
} from './fixtures/persistence-fixture';
import { assertWithinBaseline, measure } from './harness';

/**
 * Perf benches for the persistence round-trip hot paths (T04). They lock the
 * cost of the work that runs on every debounced save (serialize + the JSON
 * encode the shard store performs) and on plugin start (JSON parse + restore +
 * the two-pass retention filter). Disk IO itself is not measured: it is OS- and
 * FS-fragile, so the benches stub the vault adapter with an in-memory buffer and
 * exercise only the pure compute paths around it through the public service API.
 *
 * `applyRetention` is `protected` on PersistenceService; it is reached through a
 * one-line test subclass exactly as the production retention tests do
 * (TestPersistenceService in persistence.service.test.ts), so the bench measures
 * the real production method, not a reimplementation, without casting away the
 * type. All four `persistence.*` labels record-only against an empty baseline
 * and gate past the regression budget against a populated one. Runs node-env,
 * DOM-free.
 */

/** Exposes the protected retention pass for measurement, mirroring the prod tests. */
class BenchPersistenceService extends PersistenceService {
  public retain(snapshots: SerializedFileSnapshot[]): SerializedFileSnapshot[] {
    return this.applyRetention(snapshots);
  }
}

/**
 * Build a SnapshotsService populated with a fixture's snapshots by restoring a
 * serialized set through the public `restore` entry point. Every fixture path
 * resolves to a live file in the stub, so `restore` rebuilds a real FileSnapshot
 * per entry, leaving the service in exactly the state `serialize` would read on
 * a save.
 */
function buildPopulatedService(
  snapshots: SerializedFileSnapshot[],
  stub: PluginStub,
): SnapshotsService {
  const service = new SnapshotsService(stub.plugin as ConstructorParameters<typeof SnapshotsService>[0]);

  service.restore(snapshots);

  return service;
}

describe('persistence perf', () => {
  const medium = FIXTURE_SIZES.medium;
  const large = FIXTURE_SIZES.large;

  it('serialize over the medium fixture', () => {
    const label = `persistence.serialize.${medium.name}`;
    const snapshots = buildSerializedSnapshots(medium);
    const paths = snapshots.map((item: SerializedFileSnapshot): string => item.path);
    const stub = buildPluginStub(paths, { ...OPEN_RETENTION });
    const service = buildPopulatedService(snapshots, stub);

    // Sanity: restore actually populated the service so serialize does real work.
    expect(service.getList().length).toBe(medium.files);

    const median = measure(label, () => {
      service.serialize();
    }, 50);

    expect(median).toBeGreaterThan(0);
    expect(stub.writeCount()).toBe(0);
    assertWithinBaseline(label, median);
  });

  it('JSON.parse over the medium serialized payload', () => {
    const label = `persistence.parse.${medium.name}`;
    const payload: SerializedHistory = buildSerializedHistory(medium);
    const json: string = JSON.stringify(payload);

    const median = measure(label, () => {
      JSON.parse(json) as SerializedHistory;
    }, 50);

    expect(median).toBeGreaterThan(0);
    assertWithinBaseline(label, median);
  });

  it('restore round-trip over the medium fixture', () => {
    const label = `persistence.restore.${medium.name}`;
    const snapshots = buildSerializedSnapshots(medium);
    const paths = snapshots.map((item: SerializedFileSnapshot): string => item.path);
    const stub = buildPluginStub(paths, { ...OPEN_RETENTION });

    const median = measure(label, () => {
      // A fresh service per iteration: restore mutates the snapshot map, so a
      // single shared service would no-op after the first pass (the second
      // restore hits the "existing" adoptHistory branch). Constructing a service
      // is a bare object alloc; the FileSnapshot rebuild per entry dominates the
      // measured work, matching what restoreFromDisk pays on plugin start.
      const service = new SnapshotsService(
        stub.plugin as ConstructorParameters<typeof SnapshotsService>[0],
      );

      service.restore(snapshots);
    }, 50);

    expect(median).toBeGreaterThan(0);
    expect(stub.writeCount()).toBe(0);
    assertWithinBaseline(label, median);
  });

  it('applyRetention over the large fixture', () => {
    const label = `persistence.retention.${large.name}`;
    const snapshots = buildSerializedSnapshots(large);
    const paths = snapshots.map((item: SerializedFileSnapshot): string => item.path);
    const stub = buildPluginStub(paths, { ...OPEN_RETENTION });
    const service = new BenchPersistenceService(
      stub.plugin as ConstructorParameters<typeof PersistenceService>[0],
    );

    // applyRetention is non-mutating (filters + sorts a copy), so it can run
    // against the same fixed array every iteration without drifting the input.
    const before = snapshots.length;

    const median = measure(label, () => {
      service.retain(snapshots);
    }, 50);

    expect(median).toBeGreaterThan(0);
    expect(snapshots.length).toBe(before);
    expect(stub.writeCount()).toBe(0);
    assertWithinBaseline(label, median);
  });
});
