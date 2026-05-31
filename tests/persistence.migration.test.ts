import 'reflect-metadata';
import { describe, expect, it } from '@jest/globals';
import { HISTORY_SHARD_DIR, KeepHistory } from '@/consts';
import { ShardNameHelper } from '@/helpers/shard-name.helper';
import { PersistenceService } from '@/services/persistence.service';
import type { SerializedFileSnapshot, SerializedHistory, SerializedShard } from '@/types';

import { MemoryAdapter } from './stubs/memory-adapter';

/**
 * Regression tests for the one-time monolith-to-shard migration (Epic 10, T09).
 * They drive the real `restoreFromDisk` against the shared dir-aware
 * `MemoryAdapter`, seeding a legacy `history.json` (or its `.bak`) and asserting
 * the split into shards, the restored in-memory snapshots, the legacy-file
 * cleanup, and the skip-when-already-sharded guard, all without real disk.
 */

type PluginArg = ConstructorParameters<typeof PersistenceService>[0];

/**
 * Test-only subclass exposing the protected restore entry point and recording
 * what `SnapshotsService.restore` received, so a test can assert the in-memory
 * set produced by migration without a real snapshots service.
 */
class MigrationPersistenceService extends PersistenceService {
  public restoredSnapshots: SerializedFileSnapshot[] = [];

  public constructor(plugin: PluginArg) {
    super(plugin);
  }

  public async runRestore(): Promise<void> {
    await this.restoreFromDisk();
  }
}

interface PersistSettings {
  persist: boolean;
  keep: KeepHistory;
}

const PLUGIN_DIR: string = '.obsidian/plugins/local-history';

const HISTORY_PATH: string = `${PLUGIN_DIR}/history.json`;

const SHARD_DIR: string = `${PLUGIN_DIR}/${HISTORY_SHARD_DIR}`;

/**
 * Resolves the on-disk shard file path for a note path the same way the service
 * does (path hash + `.json` under the shard dir), so tests assert against real
 * shard filenames without hardcoding any hash.
 */
const shardPath = (notePath: string): string => `${SHARD_DIR}/${ShardNameHelper.forPath(notePath)}`;

/**
 * Builds a service whose adapter, settings, and snapshots service are fakes:
 * retention caps are 0 (disabled) so migration is asserted in isolation from
 * pruning, and the snapshots service records the restored set on the subclass.
 */
const makeService = (
  adapter: MemoryAdapter,
  persistSettings: PersistSettings = { persist: true, keep: KeepHistory.app },
): MigrationPersistenceService => {
  const settings = {
    value: (path: string): unknown => {
      if (path === 'persist') {
        return persistSettings.persist;
      }

      if (path === 'keep') {
        return persistSettings.keep;
      }

      return 0;
    },
  };

  let service: MigrationPersistenceService;

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

  service = new MigrationPersistenceService(plugin);

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

const tombstone = (
  path: string,
  timestamp: number,
  deletedTimestamp: number,
): SerializedFileSnapshot => ({
  ...entry(path, timestamp),
  deletedTimestamp,
});

/**
 * Reads back a shard file from the adapter and returns its embedded snapshot, or
 * undefined when no shard for that note path is on disk.
 */
const readShardSnapshot = (adapter: MemoryAdapter, notePath: string): SerializedFileSnapshot | undefined => {
  const raw: string | undefined = adapter.files.get(shardPath(notePath));

  if (raw === undefined) {
    return undefined;
  }

  return (JSON.parse(raw) as SerializedShard).snapshot;
};

describe('PersistenceService monolith-to-shard migration (T09)', () => {
  it('splits a legacy history.json with 3 snapshots into 3 shards and removes the legacy file', async (): Promise<void> => {
    const adapter = new MemoryAdapter();
    const now: number = Date.now();
    const legacy: SerializedHistory = {
      version: 1,
      snapshots: [
        entry('a.md', now),
        entry('b.md', now - 1000),
        // A tombstone is a normal snapshot with a deletedTimestamp; it migrates
        // like any other (no retention cap drops it here).
        tombstone('c.md', now - 2000, now - 500),
      ],
    };
    adapter.files.set(HISTORY_PATH, JSON.stringify(legacy));

    const service = makeService(adapter);
    await service.runRestore();

    // One shard per legacy snapshot, each carrying its own snapshot identity.
    expect(readShardSnapshot(adapter, 'a.md')?.path).toBe('a.md');
    expect(readShardSnapshot(adapter, 'b.md')?.path).toBe('b.md');
    expect(readShardSnapshot(adapter, 'c.md')?.deletedTimestamp).toBe(now - 500);

    // The shard version is carried through from the legacy file, not hardcoded.
    const aRaw: string | undefined = adapter.files.get(shardPath('a.md'));
    expect((JSON.parse(aRaw ?? '') as SerializedShard).version).toBe(1);

    // The legacy monolith and its atomic-write siblings are gone after migration.
    expect(adapter.files.has(HISTORY_PATH)).toBe(false);
    expect(adapter.files.has(`${HISTORY_PATH}.bak`)).toBe(false);
    expect(adapter.files.has(`${HISTORY_PATH}.tmp`)).toBe(false);

    // The migrated set is restored into memory.
    expect(service.restoredSnapshots.map((item: SerializedFileSnapshot): string => item.path).sort())
      .toEqual(['a.md', 'b.md', 'c.md']);
  });

  it('migrates from history.json.bak when the primary file is absent', async (): Promise<void> => {
    const adapter = new MemoryAdapter();
    const now: number = Date.now();
    const legacy: SerializedHistory = {
      version: 2,
      snapshots: [entry('only.md', now)],
    };
    // Only the .bak sibling survives (e.g. a crash between the monolith's old
    // tmp -> bak -> rename steps); migration must still find a usable source.
    adapter.files.set(`${HISTORY_PATH}.bak`, JSON.stringify(legacy));

    const service = makeService(adapter);
    await service.runRestore();

    expect(readShardSnapshot(adapter, 'only.md')?.path).toBe('only.md');
    // Version 2 (delta-capable) carries through the migration unchanged.
    const raw: string | undefined = adapter.files.get(shardPath('only.md'));
    expect((JSON.parse(raw ?? '') as SerializedShard).version).toBe(2);
    // The .bak source is cleaned up once migration succeeds.
    expect(adapter.files.has(`${HISTORY_PATH}.bak`)).toBe(false);
    expect(service.restoredSnapshots.map((item: SerializedFileSnapshot): string => item.path)).toEqual(['only.md']);
  });

  it('skips migration and leaves the legacy file untouched when a shard already exists', async (): Promise<void> => {
    const adapter = new MemoryAdapter();
    const now: number = Date.now();
    // A pre-existing shard means migration already happened (or this is the live
    // store), so the legacy file must never be reconsulted or removed.
    const existingShard: SerializedShard = { version: 1, snapshot: entry('existing.md', now) };
    await adapter.write(shardPath('existing.md'), JSON.stringify(existingShard));

    const legacy: SerializedHistory = {
      version: 1,
      snapshots: [entry('legacy.md', now - 1000)],
    };
    adapter.files.set(HISTORY_PATH, JSON.stringify(legacy));

    const service = makeService(adapter);
    await service.runRestore();

    // The legacy monolith is left fully intact, not migrated nor removed.
    expect(adapter.files.has(HISTORY_PATH)).toBe(true);
    expect(adapter.files.has(shardPath('legacy.md'))).toBe(false);

    // Only the pre-existing shard is restored; the legacy note is ignored.
    expect(service.restoredSnapshots.map((item: SerializedFileSnapshot): string => item.path)).toEqual(['existing.md']);
  });
});
