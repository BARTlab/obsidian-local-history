import 'reflect-metadata';
import { describe, expect, it } from '@jest/globals';
import { HISTORY_SHARD_DIR, KeepHistory } from '@/consts';
import { ShardNameHelper } from '@/helpers/shard-name.helper';
import { PersistenceService } from '@/services/persistence.service';
import type { SerializedFileSnapshot, SerializedHistory, SerializedShard } from '@/types';

import { MemoryAdapter } from './stubs/memory-adapter';

/**
 * Resilience regression for the core promise of Epic 10 (T11): one unreadable
 * shard costs exactly one note's history, never the whole store. This is the
 * test the monolith could never pass: a single bad byte in `history.json` lost
 * everything. The suite drives the real `restoreFromDisk` against the shared
 * dir-aware `MemoryAdapter`, seeding several valid shards plus one corrupt one,
 * and asserts the valid shards load while the corrupt one is silently skipped
 * (T03 per-shard `.json -> .bak -> .tmp` fallback), with no error propagating.
 */

type PluginArg = ConstructorParameters<typeof PersistenceService>[0];

/**
 * Test-only subclass exposing the protected restore entry point and recording
 * what `SnapshotsService.restore` received, so a test can assert the in-memory
 * set produced by restore without a real snapshots service.
 */
class ResiliencePersistenceService extends PersistenceService {
  public restoredSnapshots: SerializedFileSnapshot[] = [];

  public constructor(plugin: PluginArg) {
    super(plugin);
  }

  public async runRestore(): Promise<void> {
    await this.restoreFromDisk();
  }
}

const PLUGIN_DIR: string = '.obsidian/plugins/local-history';

const SHARD_DIR: string = `${PLUGIN_DIR}/${HISTORY_SHARD_DIR}`;

/**
 * Resolves the on-disk shard file path for a note path the same way the service
 * does (path hash + `.json` under the shard dir), so tests seed and assert real
 * shard filenames without hardcoding any hash.
 */
const shardPath = (notePath: string): string => `${SHARD_DIR}/${ShardNameHelper.forPath(notePath)}`;

/**
 * Builds a service whose adapter, settings, and snapshots service are fakes:
 * retention caps are 0 (disabled) so resilience is asserted in isolation from
 * pruning, and the snapshots service records the restored set on the subclass.
 */
const makeService = (adapter: MemoryAdapter): ResiliencePersistenceService => {
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

  let service: ResiliencePersistenceService;

  const snapshotsService = {
    serialize: (): SerializedHistory => ({ version: 1, snapshots: [] }),
    restore: (snapshots: SerializedFileSnapshot[]): void => {
      service.restoredSnapshots = snapshots;
    },
  };

  const plugin = {
    get: (key: string): unknown => {
      if (key === 'SettingsService') {
        return settings;
      }

      if (key === 'SnapshotsService') {
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

  service = new ResiliencePersistenceService(plugin);

  return service;
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
 * Seeds a valid shard file directly on disk (bypassing the write path) for the
 * given note path, returning the path so a test can also seed a sibling.
 */
const seedShard = (adapter: MemoryAdapter, notePath: string, timestamp: number): void => {
  const shard: SerializedShard = { version: 1, snapshot: entry(notePath, timestamp) };
  adapter.files.set(shardPath(notePath), JSON.stringify(shard));
};

const restoredPaths = (service: ResiliencePersistenceService): string[] =>
  service.restoredSnapshots.map((item: SerializedFileSnapshot): string => item.path).sort();

describe('PersistenceService corrupt-shard isolation (T11)', () => {
  it('loads the valid shards and silently skips an irrecoverably corrupt one', async (): Promise<void> => {
    const adapter = new MemoryAdapter();
    const now: number = Date.now();

    // Three structurally valid shards.
    seedShard(adapter, 'a.md', now);
    seedShard(adapter, 'b.md', now - 1000);
    seedShard(adapter, 'c.md', now - 2000);

    // One shard whose primary `.json` is invalid JSON and whose `.bak`/`.tmp`
    // siblings are absent: irrecoverable, so it must isolate to its one note.
    adapter.files.set(shardPath('corrupt.md'), '{ not valid json');

    const service = makeService(adapter);

    // The corrupt shard must never make restore throw.
    await expect(service.runRestore()).resolves.toBeUndefined();

    // Exactly the three valid snapshots survive; the corrupt one is dropped.
    expect(restoredPaths(service)).toEqual(['a.md', 'b.md', 'c.md']);
  });

  it('recovers a corrupt primary shard from its valid .bak sibling', async (): Promise<void> => {
    const adapter = new MemoryAdapter();
    const now: number = Date.now();

    seedShard(adapter, 'a.md', now);
    seedShard(adapter, 'b.md', now - 1000);
    seedShard(adapter, 'c.md', now - 2000);

    // The fourth shard's primary `.json` is corrupt, but a valid `.bak` survives
    // (e.g. a crash between the per-shard atomic write's rename steps). The
    // `.json -> .bak -> .tmp` fallback (T03) must recover the note.
    const recoverable: SerializedShard = { version: 1, snapshot: entry('recoverable.md', now - 3000) };
    adapter.files.set(shardPath('recoverable.md'), '}{ corrupt primary');
    adapter.files.set(`${shardPath('recoverable.md')}.bak`, JSON.stringify(recoverable));

    const service = makeService(adapter);

    await expect(service.runRestore()).resolves.toBeUndefined();

    // All four snapshots are restored: the recoverable one came from its `.bak`.
    expect(restoredPaths(service)).toEqual(['a.md', 'b.md', 'c.md', 'recoverable.md']);
  });
});
