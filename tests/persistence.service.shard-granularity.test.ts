import 'reflect-metadata';
import { describe, expect, it } from '@jest/globals';
import { HISTORY_SHARD_DIR, KeepHistory } from '@/consts';
import * as ShardNameHelper from '@/helpers/shard-name.helper';
import { PersistenceService } from '@/services/persistence.service';
import { TOKENS } from '@/services/tokens';
import type { SerializedFileSnapshot, SerializedHistory } from '@/types';

import type { AdapterCall } from './stubs/memory-adapter';
import { MemoryAdapter } from './stubs/memory-adapter';

/**
 * Dirty-only write granularity. These tests prove the core IO
 * benefit of the shard layout: a save touches only the shards whose content
 * actually changed and leaves every other shard's file alone, and a no-op save
 * (nothing changed) writes nothing at all. This is the regression guard against
 * the dirty-tracking degrading into a full rewrite, which would make
 * shards strictly worse than the old monolith for IO.
 *
 * The suite drives the real save path through the write queue against the shared
 * dir-aware `MemoryAdapter`, then inspects the adapter `calls` log per shard.
 */

type PluginArg = ConstructorParameters<typeof PersistenceService>[0];

/**
 * Test-only subclass that drives the save path deterministically: it exposes the
 * write queue so a test can enqueue a save and await its completion. `restored`
 * is forced true so an enqueued save is not suppressed by the pre-restore guard.
 */
class GranularityPersistenceService extends PersistenceService {
  public constructor(plugin: PluginArg) {
    super(plugin);
    // Treat restore as complete so a save actually reconciles to disk.
    this.restored = true;
  }

  public triggerSave(): void {
    this.enqueueSave();
  }

  public async drain(): Promise<void> {
    await this.writeQueue;
  }
}

const PLUGIN_DIR: string = '.obsidian/plugins/local-history';

const SHARD_DIR: string = `${PLUGIN_DIR}/${HISTORY_SHARD_DIR}`;

/**
 * Resolves the on-disk shard file path for a note path the same way the service
 * does (path hash + `.json` under the shard dir), so tests assert against real
 * shard filenames without hardcoding any hash.
 */
const shardPath = (notePath: string): string => `${SHARD_DIR}/${ShardNameHelper.forPath(notePath)}`;

/**
 * Builds a save-capable service whose `serialize` returns whatever the supplied
 * accessor yields, so a test can mutate the in-memory set between saves and drive
 * each save through the write queue. Retention is disabled (caps 0) so dirty
 * tracking is asserted in isolation from pruning.
 */
const makeService = (
  adapter: MemoryAdapter,
  serialize: () => SerializedHistory,
): GranularityPersistenceService => {
  const settings = {
    value: (path: string): unknown => {
      if (path === 'persist') {
        return true;
      }

      if (path === 'keep') {
        return KeepHistory.app;
      }

      return 0;
    },
  };

  const snapshotsService = {
    serialize,
    restore: (): void => {
      // no-op
    },
  };

  const plugin = {
    get: (key: unknown): unknown => {
      if (key === TOKENS.settings) {
        return settings;
      }

      if (key === TOKENS.snapshots) {
        return snapshotsService;
      }

      return undefined;
    },
    app: {
      vault: {
        adapter,
      },
    },
    manifest: {
      dir: PLUGIN_DIR,
      id: 'local-history',
    },
    forceUpdateEditor: (): void => {
      // no-op
    },
  } as unknown as PluginArg;

  return new GranularityPersistenceService(plugin);
};

const entry = (path: string, timestamp: number): SerializedFileSnapshot => ({
  path,
  lineBreak: '\n',
  timestamp,
  lines: [],
  state: [],
  tracker: [],
});

/**
 * Builds a tombstone snapshot (a deleted-file entry) so the tombstone
 * retention bucket can be exercised. The `deletedTimestamp` both flags it as a
 * tombstone and is the age the tombstone bucket sorts and caps by.
 */
const tombstone = (path: string, deletedTimestamp: number): SerializedFileSnapshot => ({
  ...entry(path, deletedTimestamp),
  deletedTimestamp,
});

/**
 * A mutable retention-cap holder so a test can seed every shard under a relaxed
 * cap on the first save, then tighten the cap before a second save to drive the
 * eviction (removal) pass.
 */
interface RetentionCaps {
  maxEntries: number;
  maxDeletedEntries: number;
}

/**
 * Like {@link makeService} but with live retention reading from a mutable caps
 * object, so a test can prove that tightening a cap evicts the over-cap shards'
 * files from disk on the next save. Age caps stay disabled (0) so the size cap
 * is asserted in isolation.
 */
const makeRetentionService = (
  adapter: MemoryAdapter,
  serialize: () => SerializedHistory,
  caps: RetentionCaps,
): GranularityPersistenceService => {
  const settings = {
    value: (path: string): unknown => {
      if (path === 'persist') {
        return true;
      }

      if (path === 'keep') {
        return KeepHistory.app;
      }

      if (path === 'retention.maxEntries') {
        return caps.maxEntries;
      }

      if (path === 'retention.maxDeletedEntries') {
        return caps.maxDeletedEntries;
      }

      return 0;
    },
  };

  const snapshotsService = {
    serialize,
    restore: (): void => {
      // no-op
    },
  };

  const plugin = {
    get: (key: unknown): unknown => {
      if (key === TOKENS.settings) {
        return settings;
      }

      if (key === TOKENS.snapshots) {
        return snapshotsService;
      }

      return undefined;
    },
    app: {
      vault: {
        adapter,
      },
    },
    manifest: {
      dir: PLUGIN_DIR,
      id: 'local-history',
    },
    forceUpdateEditor: (): void => {
      // no-op
    },
  } as unknown as PluginArg;

  return new GranularityPersistenceService(plugin);
};

/**
 * Counts how many recorded writes (`write` or `rename`) targeted a given shard
 * file, across both its `.tmp` staging path and its final `.json` path, so a
 * test can assert that exactly one shard was rewritten and the others untouched.
 * The atomic mechanic stages at `<shard>.tmp` then renames it onto `<shard>`, so
 * both the `.tmp` argument and the final path count as touching that shard.
 */
const writesTouching = (calls: readonly AdapterCall[], shard: string): number =>
  calls.filter((call: AdapterCall): boolean =>
    (call.op === 'write' || call.op === 'rename')
    && call.args.some((arg: string): boolean => arg === shard || arg === `${shard}.tmp` || arg === `${shard}.bak`)
  ).length;

/**
 * Total number of shard writes recorded (any `write` or `rename` under the shard
 * dir), used to assert a no-op save performs zero shard IO.
 */
const totalShardWrites = (calls: readonly AdapterCall[]): number =>
  calls.filter((call: AdapterCall): boolean =>
    (call.op === 'write' || call.op === 'rename')
    && call.args.some((arg: string): boolean => arg.startsWith(`${SHARD_DIR}/`))
  ).length;

describe('PersistenceService dirty-only write granularity', () => {
  it('rewrites exactly the one changed shard and leaves the others untouched', async (): Promise<void> => {
    const adapter = new MemoryAdapter();
    const now: number = Date.now();

    // Three live snapshots; the test mutates only `b.md` for the second save.
    const snapshots: SerializedFileSnapshot[] = [
      entry('a.md', now),
      entry('b.md', now - 1000),
      entry('c.md', now - 2000),
    ];

    const service = makeService(adapter, (): SerializedHistory => ({ version: 1, snapshots }));

    // First save: seeds the index and writes all three shards from a clean slate.
    service.triggerSave();
    await service.drain();

    expect(adapter.files.has(shardPath('a.md'))).toBe(true);
    expect(adapter.files.has(shardPath('b.md'))).toBe(true);
    expect(adapter.files.has(shardPath('c.md'))).toBe(true);

    // Discard the seeding IO so the assertions below see only the second save.
    adapter.calls = [];

    // Mutate exactly one snapshot (b.md) in place; a.md and c.md are byte-identical.
    snapshots[1] = entry('b.md', now - 1000 + 1);

    service.triggerSave();
    await service.drain();

    // Exactly the changed shard was rewritten; the two unchanged shards saw no IO.
    expect(writesTouching(adapter.calls, shardPath('b.md'))).toBeGreaterThan(0);
    expect(writesTouching(adapter.calls, shardPath('a.md'))).toBe(0);
    expect(writesTouching(adapter.calls, shardPath('c.md'))).toBe(0);

    // The mutation actually landed on disk for the one shard that changed.
    expect(readShardTimestamp(adapter, 'b.md')).toBe(now - 1000 + 1);
    // The untouched shards retain their original content.
    expect(readShardTimestamp(adapter, 'a.md')).toBe(now);
    expect(readShardTimestamp(adapter, 'c.md')).toBe(now - 2000);
  });

  it('performs zero shard writes on a no-op save', async (): Promise<void> => {
    const adapter = new MemoryAdapter();
    const now: number = Date.now();

    const snapshots: SerializedFileSnapshot[] = [
      entry('a.md', now),
      entry('b.md', now - 1000),
    ];

    const service = makeService(adapter, (): SerializedHistory => ({ version: 1, snapshots }));

    // First save seeds the index with both shards' digests.
    service.triggerSave();
    await service.drain();

    adapter.calls = [];

    // Second save with nothing changed: every digest matches the index, so the
    // write pass skips all shards and the removal pass finds no orphan to drop.
    service.triggerSave();
    await service.drain();

    expect(totalShardWrites(adapter.calls)).toBe(0);
  });
});

/**
 * Retention evicts shards from disk. The global retention policy
 * runs in memory over the full snapshot set; what changes under the shard layout
 * is that an evicted entry must have its shard file removed from disk, not just
 * trimmed from an array. These tests guard the removal (reconcile-deletions) pass
 * of the save path for both retention buckets: live snapshots capped by
 * `retention.maxEntries` and tombstones capped by `retention.maxDeletedEntries`.
 *
 * Each test seeds every shard under a relaxed cap on a first save, then tightens
 * the cap and saves again so the now-over-cap shards are evicted: this exercises
 * the removal pass (which only deletes shards already indexed on disk) rather
 * than retention silently never-writing an over-cap shard.
 */
describe('PersistenceService retention evicts shards from disk', () => {
  it('removes over-cap live shards and keeps the newest within maxEntries', async (): Promise<void> => {
    const adapter = new MemoryAdapter();
    const now: number = Date.now();

    // Four live snapshots, newest first by timestamp: a (newest) .. d (oldest).
    const snapshots: SerializedFileSnapshot[] = [
      entry('a.md', now),
      entry('b.md', now - 1000),
      entry('c.md', now - 2000),
      entry('d.md', now - 3000),
    ];

    const caps: RetentionCaps = { maxEntries: 0, maxDeletedEntries: 0 };
    const service = makeRetentionService(
      adapter,
      (): SerializedHistory => ({ version: 1, snapshots }),
      caps,
    );

    // First save with retention disabled (cap 0): all four shards land on disk
    // and enter the index, so the second save's removal pass has something to evict.
    service.triggerSave();
    await service.drain();

    for (const note of ['a.md', 'b.md', 'c.md', 'd.md']) {
      expect(adapter.files.has(shardPath(note))).toBe(true);
    }

    // Tighten the live cap to 2 and save again: retention keeps the two newest
    // (a, b) and the removal pass must delete the two over-cap shards (c, d).
    caps.maxEntries = 2;
    service.triggerSave();
    await service.drain();

    expect(adapter.files.has(shardPath('a.md'))).toBe(true);
    expect(adapter.files.has(shardPath('b.md'))).toBe(true);
    expect(adapter.files.has(shardPath('c.md'))).toBe(false);
    expect(adapter.files.has(shardPath('d.md'))).toBe(false);

    // No leftover atomic-write siblings of the evicted shards either.
    expect(adapter.files.has(`${shardPath('c.md')}.bak`)).toBe(false);
    expect(adapter.files.has(`${shardPath('c.md')}.tmp`)).toBe(false);
    expect(adapter.files.has(`${shardPath('d.md')}.bak`)).toBe(false);
    expect(adapter.files.has(`${shardPath('d.md')}.tmp`)).toBe(false);
  });

  it('removes a tombstone shard once it is over the deleted cap', async (): Promise<void> => {
    const adapter = new MemoryAdapter();
    const now: number = Date.now();

    // One live note plus two tombstones (deleted-file entries); the tombstone
    // bucket is capped independently of the live bucket.
    const snapshots: SerializedFileSnapshot[] = [
      entry('live.md', now),
      tombstone('gone-new.md', now - 1000),
      tombstone('gone-old.md', now - 2000),
    ];

    const caps: RetentionCaps = { maxEntries: 0, maxDeletedEntries: 0 };
    const service = makeRetentionService(
      adapter,
      (): SerializedHistory => ({ version: 1, snapshots }),
      caps,
    );

    // First save with both caps disabled: live shard and both tombstone shards land.
    service.triggerSave();
    await service.drain();

    expect(adapter.files.has(shardPath('live.md'))).toBe(true);
    expect(adapter.files.has(shardPath('gone-new.md'))).toBe(true);
    expect(adapter.files.has(shardPath('gone-old.md'))).toBe(true);

    // Cap the tombstone bucket at 1 and save again: the older tombstone is over
    // cap and its shard must be removed, while the live note (separate bucket,
    // still uncapped) and the newest tombstone remain.
    caps.maxDeletedEntries = 1;
    service.triggerSave();
    await service.drain();

    expect(adapter.files.has(shardPath('live.md'))).toBe(true);
    expect(adapter.files.has(shardPath('gone-new.md'))).toBe(true);
    expect(adapter.files.has(shardPath('gone-old.md'))).toBe(false);
    expect(adapter.files.has(`${shardPath('gone-old.md')}.bak`)).toBe(false);
    expect(adapter.files.has(`${shardPath('gone-old.md')}.tmp`)).toBe(false);
  });
});

/**
 * Reads back a shard file from the adapter and returns its embedded snapshot
 * timestamp, asserting it is present so a test can verify which content landed.
 */
const readShardTimestamp = (adapter: MemoryAdapter, notePath: string): number => {
  const raw: string | undefined = adapter.files.get(shardPath(notePath));

  expect(raw).toBeDefined();

  return (JSON.parse(raw ?? '') as { snapshot: SerializedFileSnapshot }).snapshot.timestamp;
};
