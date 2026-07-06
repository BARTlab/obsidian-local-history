import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { HISTORY_SHARD_DIR, KeepHistory } from '@/consts';
import * as ShardNameHelper from '@/helpers/shard-name.helper';
import { PersistenceService } from '@/services/persistence.service';
import { TOKENS } from '@/services/tokens';
import type { SerializedFileSnapshot, SerializedHistory, SerializedShard } from '@/types';

import { MemoryAdapter } from './stubs/memory-adapter';

/**
 * Resilience regressions for the core promise of the sharded store.
 *
 * One unreadable shard costs exactly one note's history, never the whole
 * store. This is the test the monolith could never pass: a single bad byte in
 * `history.json` lost everything. The suite drives the real `restoreFromDisk`
 * against the shared dir-aware `MemoryAdapter`, seeding several valid shards plus
 * one corrupt one, and asserts the valid shards load while the corrupt one is
 * silently skipped (the per-shard `.json -> .bak -> .tmp` fallback), with no
 * error propagating.
 *
 * A failure during a shard's atomic `tmp -> bak -> rename` write leaves
 * either the prior shard intact or a recoverable `.bak`/`.tmp`, never a truncated
 * primary. The suite arms the adapter's `failNextRename` at shard scope, drives a
 * real save through the write queue, then runs a real restore and asserts the
 * note's history still loads and that no zero/partial primary masquerades as
 * valid.
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

describe('PersistenceService corrupt-shard isolation', () => {
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
    // `.json -> .bak -> .tmp` fallback must recover the note.
    const recoverable: SerializedShard = { version: 1, snapshot: entry('recoverable.md', now - 3000) };
    adapter.files.set(shardPath('recoverable.md'), '}{ corrupt primary');
    adapter.files.set(`${shardPath('recoverable.md')}.bak`, JSON.stringify(recoverable));

    const service = makeService(adapter);

    await expect(service.runRestore()).resolves.toBeUndefined();

    // All four snapshots are restored: the recoverable one came from its `.bak`.
    expect(restoredPaths(service)).toEqual(['a.md', 'b.md', 'c.md', 'recoverable.md']);
  });
});

/**
 * Test-only subclass that also drives the save path: it exposes the write
 * queue so a test can enqueue a save and drain it deterministically, on top of
 * the restore entry point inherited via {@link ResiliencePersistenceService}.
 * `restored` is forced true in the constructor so an enqueued save is not
 * suppressed by the pre-restore guard.
 */
class RenameFailurePersistenceService extends ResiliencePersistenceService {
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

/**
 * Builds a save-capable service whose `serialize` returns a single snapshot for
 * the given note path and timestamp, so a test can drive a real shard write (and
 * a second write that overwrites the same shard) through the write queue. The
 * snapshots service still records the restored set so the later restore can be
 * asserted. Retention is disabled (caps 0) to isolate the rename-failure path.
 */
const makeSaveService = (
  adapter: MemoryAdapter,
  serialize: () => SerializedHistory,
): RenameFailurePersistenceService => {
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

  let service: RenameFailurePersistenceService;

  const snapshotsService = {
    serialize,
    restore: (snapshots: SerializedFileSnapshot[]): void => {
      service.restoredSnapshots = snapshots;
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

  service = new RenameFailurePersistenceService(plugin);

  return service;
};

const singleSnapshotPayload = (notePath: string, timestamp: number): SerializedHistory => ({
  version: 1,
  snapshots: [entry(notePath, timestamp)],
});

/**
 * Whether any on-disk variant of a shard parses into a structurally valid shard
 * with the embedded note path. Mirrors how the store decides a variant is
 * usable, so the test can assert that a truncated/partial primary is NOT what is
 * recovered (no zero-byte or half-written file masquerading as the note).
 */
const variantHasValidPath = (adapter: MemoryAdapter, variantPath: string, notePath: string): boolean => {
  const raw: string | undefined = adapter.files.get(variantPath);

  if (raw === undefined) {
    return false;
  }

  try {
    const shard: SerializedShard = JSON.parse(raw) as SerializedShard;

    return shard.snapshot?.path === notePath;
  } catch {
    return false;
  }
};

describe('PersistenceService per-shard rename-failure recovery', () => {
  it('survives a failed backup rename without truncating the shard on overwrite', async (): Promise<void> => {
    const adapter = new MemoryAdapter();
    let counter: number = 0;
    // Same note path on both saves so the second save overwrites one shard and
    // exercises the atomic tmp -> bak -> rename mechanic on an existing primary.
    const service = makeSaveService(adapter, (): SerializedHistory => {
      counter += 1;

      return singleSnapshotPayload('rename-fail.md', counter);
    });

    // First save: clean write, leaves a valid primary (timestamp 1), no .bak/.tmp.
    service.triggerSave();
    await service.drain();

    const primary: string = shardPath('rename-fail.md');
    expect(adapter.files.has(primary)).toBe(true);
    expect(adapter.files.has(`${primary}.bak`)).toBe(false);

    // Second save: arm a rename failure. On an overwrite the first rename is the
    // best-effort backup (json -> bak); writeShard swallows that failure so it
    // cannot abort the write, then the final rename (tmp -> json) swaps the new
    // content in. The net effect is an intact, fully valid primary (never a
    // truncated/partial file) and no exception escaping the queue.
    adapter.failNextRename = true;
    service.triggerSave();
    await expect(service.drain()).resolves.toBeUndefined();

    // The primary is a structurally valid shard, not a zero/partial file.
    expect(variantHasValidPath(adapter, primary, 'rename-fail.md')).toBe(true);
    const survived: SerializedShard = JSON.parse(adapter.files.get(primary) ?? '') as SerializedShard;
    expect(survived.snapshot.timestamp).toBe(2);
    // No orphan .tmp lingers after the write completes.
    expect(adapter.files.has(`${primary}.tmp`)).toBe(false);

    // A subsequent restore recovers the note from the intact primary, no throw.
    const restorer = makeService(adapter);
    await expect(restorer.runRestore()).resolves.toBeUndefined();
    expect(restoredPaths(restorer)).toEqual(['rename-fail.md']);
  });

  it('recovers the note from its .bak when the primary rename fails mid-write', async (): Promise<void> => {
    const adapter = new MemoryAdapter();

    // Pre-seed a valid .bak as if a prior crash had backed up the note but left
    // no primary (the crash-between-rename-steps state the store guards against).
    const recoverable: SerializedShard = { version: 1, snapshot: entry('recover.md', 100) };
    adapter.files.set(`${shardPath('recover.md')}.bak`, JSON.stringify(recoverable));

    const service = makeSaveService(adapter, (): SerializedHistory => singleSnapshotPayload('recover.md', 200));

    // No primary exists, so the write has a single rename (tmp -> json); arming
    // failNextRename makes that rename fail. The write goes to .tmp, the rename
    // throws, and the orphan .tmp is cleaned up, leaving no primary at all.
    adapter.failNextRename = true;
    service.triggerSave();
    await expect(service.drain()).resolves.toBeUndefined();

    const primary: string = shardPath('recover.md');
    // No primary masquerading as valid: the failed write left nothing in place.
    expect(adapter.files.has(primary)).toBe(false);
    // The orphan .tmp was cleaned up, not left to be mistaken for the note.
    expect(adapter.files.has(`${primary}.tmp`)).toBe(false);
    // The pre-existing .bak is the only surviving recovery source.
    expect(variantHasValidPath(adapter, `${primary}.bak`, 'recover.md')).toBe(true);

    // Restore recovers the note via the .json -> .bak -> .tmp fallback, no throw.
    const restorer = makeService(adapter);
    await expect(restorer.runRestore()).resolves.toBeUndefined();
    expect(restoredPaths(restorer)).toEqual(['recover.md']);
  });
});
