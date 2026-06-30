import 'reflect-metadata';
import { describe, expect, it, jest } from '@jest/globals';
import { HISTORY_SHARD_DIR, KeepHistory, SAVE_DEBOUNCE_MS } from '@/consts';
import * as ShardNameHelper from '@/helpers/shard-name.helper';
import { PersistenceService } from '@/services/persistence.service';
import { TOKENS } from '@/services/tokens';
import type { SerializedFileSnapshot, SerializedHistory, SerializedShard } from '@/types';

import { MemoryAdapter } from './stubs/memory-adapter';

/**
 * Tests for the retention caps in PersistenceService. They drive the
 * pruning logic directly with controlled settings so the size cap (eviction)
 * and age cap (expiry) are verified without any disk or Obsidian dependency.
 */

type PluginArg = ConstructorParameters<typeof PersistenceService>[0];

/**
 * Test-only subclass exposing the protected pruning method and letting the test
 * inject retention values without an Obsidian SettingsService.
 */
class TestPersistenceService extends PersistenceService {
  public constructor(plugin: PluginArg) {
    super(plugin);
  }

  public prune(snapshots: SerializedFileSnapshot[]): SerializedFileSnapshot[] {
    return this.applyRetention(snapshots);
  }
}

/**
 * Builds a service whose injected SettingsService returns the given retention
 * caps. The @Inject getter resolves through plugin.get, so the fake is wired
 * there. Tombstone caps default to 0 (disabled) so existing tests keep covering
 * only the live-bucket behaviour they were written for.
 */
const makeService = (
  maxEntries: number,
  maxAgeDays: number,
  maxDeletedEntries: number = 0,
  maxDeletedAgeDays: number = 0,
): TestPersistenceService => {
  const settings = {
    value: (path: string): number => {
      if (path === 'retention.maxEntries') {
        return maxEntries;
      }

      if (path === 'retention.maxAgeDays') {
        return maxAgeDays;
      }

      if (path === 'retention.maxDeletedEntries') {
        return maxDeletedEntries;
      }

      if (path === 'retention.maxDeletedAgeDays') {
        return maxDeletedAgeDays;
      }

      return 0;
    },
  };

  const plugin = {
    get: (): unknown => settings,
  } as unknown as PluginArg;

  return new TestPersistenceService(plugin);
};

const entry = (path: string, timestamp: number): SerializedFileSnapshot =>
  ({
    path,
    lineBreak: '\n',
    timestamp,
    lines: [],
    state: [],
    tracker: [],
  });

const tombstone = (path: string, timestamp: number, deletedTimestamp: number): SerializedFileSnapshot =>
  ({
    path,
    lineBreak: '\n',
    timestamp,
    lines: [],
    state: [],
    tracker: [],
    deletedTimestamp,
  });

const DAY: number = 24 * 60 * 60 * 1000;

describe('PersistenceService retention size cap', () => {
  it('keeps only the newest entries up to maxEntries', () => {
    const service = makeService(2, 0);
    const now: number = Date.now();

    const kept = service.prune([
      entry('old.md', now - (3 * DAY)),
      entry('mid.md', now - (2 * DAY)),
      entry('new.md', now - DAY),
    ]);

    expect(kept.map((item: SerializedFileSnapshot): string => item.path)).toEqual(['new.md', 'mid.md']);
  });

  it('keeps everything when maxEntries is 0 (disabled)', () => {
    const service = makeService(0, 0);
    const now: number = Date.now();

    const kept = service.prune([
      entry('a.md', now - DAY),
      entry('b.md', now - (2 * DAY)),
      entry('c.md', now - (3 * DAY)),
    ]);

    expect(kept).toHaveLength(3);
  });
});

describe('PersistenceService retention age cap', () => {
  it('does NOT drop live entries older than maxAgeDays (live files are age-exempt)', () => {
    // Live files are no longer age-pruned: a still-present file keeps its
    // history regardless of age, so an idle vault is never wiped. The age cap
    // applies only to tombstones (covered in the tombstone-caps suite).
    const service = makeService(0, 7);
    const now: number = Date.now();

    const kept = service.prune([
      entry('fresh.md', now - (1 * DAY)),
      entry('stale.md', now - (30 * DAY)),
    ]);

    expect(kept.map((item: SerializedFileSnapshot): string => item.path)).toEqual(['fresh.md', 'stale.md']);
  });

  it('keeps everything when maxAgeDays is 0 (disabled)', () => {
    const service = makeService(0, 0);
    const now: number = Date.now();

    const kept = service.prune([
      entry('old.md', now - (3650 * DAY)),
    ]);

    expect(kept).toHaveLength(1);
  });

  it('keeps a very old live entry even when maxAgeDays is set', () => {
    // Belt-and-suspenders for the idle-vault wipe: even an entry far past the
    // age cap survives because live files are bounded by count only.
    const service = makeService(0, 30);
    const now: number = Date.now();

    const kept = service.prune([
      entry('ancient.md', now - (3650 * DAY)),
    ]);

    expect(kept).toHaveLength(1);
  });
});

describe('PersistenceService retention combined caps', () => {
  it('ignores the live age cap and applies only the size cap', () => {
    const service = makeService(2, 7);
    const now: number = Date.now();

    const kept = service.prune([
      entry('new.md', now - DAY),
      entry('mid.md', now - (2 * DAY)),
      entry('old.md', now - (10 * DAY)),
    ]);

    // Age no longer prunes live entries; the size cap keeps the two newest.
    expect(kept.map((item: SerializedFileSnapshot): string => item.path)).toEqual(['new.md', 'mid.md']);
  });

  it('returns an empty list for non-array input', () => {
    const service = makeService(10, 10);

    expect(service.prune(null as unknown as SerializedFileSnapshot[])).toEqual([]);
  });
});

describe('PersistenceService retention tombstone caps', () => {
  it('applies live caps to live entries and tombstone caps to tombstones independently', () => {
    // Live cap: 1 entry, age unlimited. Tombstone cap: 2 entries, age unlimited.
    const service = makeService(1, 0, 2, 0);
    const now: number = Date.now();

    const kept = service.prune([
      entry('live-new.md', now - DAY),
      entry('live-old.md', now - (2 * DAY)),
      tombstone('dead-new.md', now - (10 * DAY), now - DAY),
      tombstone('dead-mid.md', now - (10 * DAY), now - (2 * DAY)),
      tombstone('dead-old.md', now - (10 * DAY), now - (3 * DAY)),
    ]);

    const paths: string[] = kept.map((item: SerializedFileSnapshot): string => item.path);
    // Live bucket keeps only the newest of the two live entries.
    expect(paths).toContain('live-new.md');
    expect(paths).not.toContain('live-old.md');
    // Tombstone bucket keeps the two newest by deletedTimestamp.
    expect(paths).toContain('dead-new.md');
    expect(paths).toContain('dead-mid.md');
    expect(paths).not.toContain('dead-old.md');
  });

  it('keeps every tombstone when maxDeletedEntries is 0 (disabled), even with many entries', () => {
    const service = makeService(0, 0, 0, 0);
    const now: number = Date.now();

    const tombstones: SerializedFileSnapshot[] = Array.from({ length: 1000 }, (_, index: number): SerializedFileSnapshot =>
      tombstone(`gone-${index}.md`, now - (10 * DAY), now - (index * 1000))
    );

    const kept = service.prune(tombstones);

    expect(kept).toHaveLength(1000);
  });

  it('ages tombstones by deletedTimestamp, not by snapshot timestamp', () => {
    // Tombstone whose source snapshot is ancient but was deleted yesterday must
    // survive a 7-day age cap because its deletion is fresh.
    const service = makeService(0, 0, 0, 7);
    const now: number = Date.now();

    const kept = service.prune([
      tombstone('fresh-deletion.md', now - (365 * DAY), now - DAY),
      tombstone('stale-deletion.md', now - DAY, now - (30 * DAY)),
    ]);

    const paths: string[] = kept.map((item: SerializedFileSnapshot): string => item.path);
    expect(paths).toEqual(['fresh-deletion.md']);
  });

  it('live caps do not evict tombstones and tombstone caps do not evict live entries', () => {
    // Live cap is 0 (disabled), tombstone cap is 1: many live entries survive,
    // only one tombstone survives.
    const service = makeService(0, 0, 1, 0);
    const now: number = Date.now();

    const kept = service.prune([
      entry('a.md', now - DAY),
      entry('b.md', now - (2 * DAY)),
      entry('c.md', now - (3 * DAY)),
      tombstone('dead-1.md', now - (10 * DAY), now - DAY),
      tombstone('dead-2.md', now - (10 * DAY), now - (2 * DAY)),
    ]);

    const livePaths: string[] = kept
      .filter((item: SerializedFileSnapshot): boolean => item.deletedTimestamp === undefined)
      .map((item: SerializedFileSnapshot): string => item.path);

    const deadPaths: string[] = kept
      .filter((item: SerializedFileSnapshot): boolean => item.deletedTimestamp !== undefined)
      .map((item: SerializedFileSnapshot): string => item.path);

    expect(livePaths).toHaveLength(3);
    expect(deadPaths).toEqual(['dead-1.md']);
  });
});

/**
 * Tests for the serialized + atomic + backed-up write pipeline ported
 * to the sharded layout. They drive the shared dir-aware
 * `MemoryAdapter` so the queue serialization, per-shard atomic replace, and
 * per-shard `.bak` behaviour are verified end-to-end against shard files under
 * `<plugindir>/history/`, not the legacy monolith, without touching real disk.
 */

/**
 * Test-only subclass exposing the protected write surface and the internal
 * write queue so a test can drain it without using the real `unload` path.
 */
class WritePersistenceService extends PersistenceService {
  public constructor(plugin: PluginArg) {
    super(plugin);
    // Treat restore as complete so settings/snapshot triggers actually enqueue.
    this.restored = true;
  }

  public triggerSave(): void {
    this.enqueueSave();
  }

  public triggerClear(): void {
    this.enqueueClear();
  }

  public async drain(): Promise<void> {
    await this.writeQueue;
  }
}

interface PersistSettings {
  persist: boolean;
  keep: KeepHistory;
}

const makeWriteService = (
  adapter: MemoryAdapter,
  serialize: () => SerializedHistory,
  persistSettings: PersistSettings = { persist: true, keep: KeepHistory.app },
): WritePersistenceService => {
  const settings = {
    value: (path: string): unknown => {
      if (path === 'persist') {
        return persistSettings.persist;
      }

      if (path === 'keep') {
        return persistSettings.keep;
      }

      if (path === 'retention.maxEntries' || path === 'retention.maxAgeDays') {
        return 0;
      }

      if (path === 'retention.maxDeletedEntries' || path === 'retention.maxDeletedAgeDays') {
        return 0;
      }

      return 0;
    },
  };

  const snapshotsService = {
    serialize,
    restore: (): void => {
      // unused in these tests
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
      dir: '.obsidian/plugins/local-history',
      id: 'local-history',
    },
    forceUpdateEditor: (): void => {
      // no-op
    },
  } as unknown as PluginArg;

  return new WritePersistenceService(plugin);
};

const SHARD_DIR: string = `.obsidian/plugins/local-history/${HISTORY_SHARD_DIR}`;

/**
 * Resolves the on-disk shard file path for a note path the same way the service
 * does (path hash + `.json` under the shard dir), so tests assert against real
 * shard filenames without hardcoding any hash.
 */
const shardPath = (notePath: string): string => `${SHARD_DIR}/${ShardNameHelper.forPath(notePath)}`;

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

const payload = (path: string, timestamp: number): SerializedHistory => ({
  version: 1,
  snapshots: [entry(path, timestamp)],
});

describe('PersistenceService write queue', () => {
  it('serializes overlapping saves so the later payload wins in its shard', async (): Promise<void> => {
    const adapter = new MemoryAdapter();
    let counter: number = 0;
    // Same note path on both saves so they target one shard; only the content
    // (timestamp) changes, so the second save observes the first already on disk
    // and backs it up before swapping in its own.
    const service = makeWriteService(adapter, (): SerializedHistory => {
      counter += 1;

      return payload('overlap.md', counter);
    });

    // First save sees a slow write, second is enqueued before the first
    // finishes. With one queue the second must observe the first's output
    // already in its shard (prior shard copied to .bak before the second rename).
    adapter.writeDelay = 20;

    service.triggerSave();
    service.triggerSave();
    await service.drain();

    const live: SerializedFileSnapshot | undefined = readShardSnapshot(adapter, 'overlap.md');
    expect(live).toBeDefined();
    expect(live?.timestamp).toBe(2);

    // The shard's .bak holds the prior (first) write so the second was not a clobber.
    const backupRaw: string | undefined = adapter.files.get(`${shardPath('overlap.md')}.bak`);
    expect(backupRaw).toBeDefined();
    const backup: SerializedShard = JSON.parse(backupRaw ?? '') as SerializedShard;
    expect(backup.snapshot.timestamp).toBe(1);
  });

  it('unload awaits an in-flight save and the final state is persisted to its shard', async (): Promise<void> => {
    const adapter = new MemoryAdapter();
    const service = makeWriteService(adapter, (): SerializedHistory => payload('unload.md', 1));

    adapter.writeDelay = 15;
    service.triggerSave();

    await service.unload();

    const snapshot: SerializedFileSnapshot | undefined = readShardSnapshot(adapter, 'unload.md');
    expect(snapshot).toBeDefined();
    expect(snapshot?.path).toBe('unload.md');
  });

  it('writes each shard atomically through .tmp + rename and produces a .bak of the prior shard', async (): Promise<void> => {
    const adapter = new MemoryAdapter();
    let counter: number = 0;
    // One note path, changing content, so the same shard is overwritten on the
    // second save and the atomic tmp -> bak -> rename mechanic is exercised.
    const service = makeWriteService(adapter, (): SerializedHistory => {
      counter += 1;

      return payload('atom.md', counter);
    });

    service.triggerSave();
    await service.drain();
    // First write: tmp + rename, no prior shard so no .bak and no leftover .tmp.
    const path: string = shardPath('atom.md');
    expect(adapter.files.has(path)).toBe(true);
    expect(adapter.files.has(`${path}.bak`)).toBe(false);
    expect(adapter.files.has(`${path}.tmp`)).toBe(false);

    service.triggerSave();
    await service.drain();
    // Second write: prior shard existed, must have been moved to .bak.
    expect(adapter.files.has(`${path}.bak`)).toBe(true);
    const bak: SerializedShard = JSON.parse(adapter.files.get(`${path}.bak`) ?? '') as SerializedShard;
    expect(bak.snapshot.timestamp).toBe(1);
    const live: SerializedShard = JSON.parse(adapter.files.get(path) ?? '') as SerializedShard;
    expect(live.snapshot.timestamp).toBe(2);
    // No orphan .tmp is left behind after a clean overwrite.
    expect(adapter.files.has(`${path}.tmp`)).toBe(false);
  });

  it('clears the on-disk shards even when persistence is disabled', async (): Promise<void> => {
    const adapter = new MemoryAdapter();
    // Seed a stale shard so the disabled-clear path has something to wipe.
    await adapter.write(shardPath('stale.md'), JSON.stringify({ version: 1, snapshot: payload('stale.md', 1).snapshots[0] }));

    const service = makeWriteService(
      adapter,
      (): SerializedHistory => payload('ignored.md', 1),
      { persist: false, keep: KeepHistory.app },
    );

    service.triggerClear();
    await service.drain();

    expect(adapter.files.has(shardPath('stale.md'))).toBe(false);
    expect(await adapter.exists(SHARD_DIR)).toBe(false);
  });

  it('debounced saves are coalesced and routed through the queue', async (): Promise<void> => {
    jest.useFakeTimers();

    try {
      const adapter = new MemoryAdapter();
      let calls: number = 0;
      const service = makeWriteService(adapter, (): SerializedHistory => {
        calls += 1;

        return payload('debounced.md', calls);
      });

      service.onSnapshotsUpdate();
      service.onSnapshotsUpdate();
      service.onSnapshotsUpdate();

      jest.advanceTimersByTime(SAVE_DEBOUNCE_MS + 1);
      jest.useRealTimers();
      await service.drain();

      // Only one serialize call happened because the timer collapsed the three triggers.
      expect(calls).toBe(1);
      const snapshot: SerializedFileSnapshot | undefined = readShardSnapshot(adapter, 'debounced.md');
      expect(snapshot).toBeDefined();
      expect(snapshot?.timestamp).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });
});

/**
 * Regression tests for the data-loss guard on the save path. A `serialize()`
 * that throws (a single corrupt snapshot's `toJSON`, an encode edge) must never
 * be mistaken for "nothing to keep" and wipe the on-disk history, and a single
 * throwing save must never poison the write queue so later saves and the
 * `unload` flush keep running. Together these close the "history resets for the
 * whole vault" path a transient serialization fault could otherwise trigger.
 */
describe('PersistenceService save-path data-loss guard', () => {
  it('does not wipe existing shards when serialize throws, and retries on the next save', async (): Promise<void> => {
    const adapter = new MemoryAdapter();
    let mode: 'ok' | 'throw' = 'ok';
    const service = makeWriteService(adapter, (): SerializedHistory => {
      if (mode === 'throw') {
        throw new Error('serialize boom');
      }

      return payload('keep.md', 1);
    });

    // First good save lands a shard on disk.
    service.triggerSave();
    await service.drain();
    expect(readShardSnapshot(adapter, 'keep.md')).toBeDefined();

    // A save whose serialize throws must leave the existing shard untouched
    // (no clearAll, no wipe) rather than treating the failure as an empty set.
    mode = 'throw';
    service.triggerSave();
    await service.drain();
    expect(readShardSnapshot(adapter, 'keep.md')).toBeDefined();
    expect(await adapter.exists(SHARD_DIR)).toBe(true);
  });

  it('keeps the queue alive after a throwing save so later saves still persist', async (): Promise<void> => {
    const adapter = new MemoryAdapter();
    let serializeCalls: number = 0;
    let mode: 'ok' | 'throw' = 'throw';
    const service = makeWriteService(adapter, (): SerializedHistory => {
      serializeCalls += 1;

      if (mode === 'throw') {
        throw new Error('serialize boom');
      }

      return payload('recovered.md', 1);
    });

    // First save throws; with an unguarded `.then` chain this would reject the
    // stored writeQueue and starve every later save forever.
    service.triggerSave();
    await service.drain();

    mode = 'ok';
    const before: number = serializeCalls;
    service.triggerSave();
    await service.drain();

    // The recovery save actually ran serialize and wrote its shard, proving the
    // queue was not poisoned by the earlier throw.
    expect(serializeCalls).toBeGreaterThan(before);
    expect(readShardSnapshot(adapter, 'recovered.md')).toBeDefined();
  });

  it('unload flushes a final save even after a prior save threw', async (): Promise<void> => {
    const adapter = new MemoryAdapter();
    let mode: 'ok' | 'throw' = 'throw';
    const service = makeWriteService(adapter, (): SerializedHistory => {
      if (mode === 'throw') {
        throw new Error('serialize boom');
      }

      return payload('final.md', 1);
    });

    service.triggerSave();
    await service.drain();

    // unload enqueues a final save and awaits the queue; a poisoned queue would
    // reject here and drop the flush.
    mode = 'ok';
    await expect(service.unload()).resolves.toBeUndefined();
    expect(readShardSnapshot(adapter, 'final.md')).toBeDefined();
  });
});

/**
 * Regression tests for the idle-vault total-wipe guard. Live files are no longer
 * age-pruned, so a vault left untouched past `maxAgeDays` must keep every live
 * file's on-disk history; only the count cap bounds live files, and only
 * deleted-file tombstones still expire by age. The save path must reconcile
 * per-shard and must NOT wipe the whole shard directory while live in-memory
 * history exists.
 */

interface RetentionCaps {
  maxEntries: number;
  maxAgeDays: number;
  maxDeletedEntries: number;
  maxDeletedAgeDays: number;
}

/**
 * Builds a write service whose injected SettingsService returns the given
 * retention caps (the default `makeWriteService` hardcodes them all to 0), so a
 * test can exercise the live count cap, the tombstone age cap, and the
 * idle-vault no-wipe path against a real multi-snapshot payload on the
 * `MemoryAdapter`.
 */
const makeRetentionWriteService = (
  adapter: MemoryAdapter,
  serialize: () => SerializedHistory,
  caps: RetentionCaps,
): WritePersistenceService => {
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

      if (path === 'retention.maxAgeDays') {
        return caps.maxAgeDays;
      }

      if (path === 'retention.maxDeletedEntries') {
        return caps.maxDeletedEntries;
      }

      if (path === 'retention.maxDeletedAgeDays') {
        return caps.maxDeletedAgeDays;
      }

      return 0;
    },
  };

  const snapshotsService = {
    serialize,
    restore: (): void => {
      // unused in these tests
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
      dir: '.obsidian/plugins/local-history',
      id: 'local-history',
    },
    forceUpdateEditor: (): void => {
      // no-op
    },
  } as unknown as PluginArg;

  return new WritePersistenceService(plugin);
};

const multiPayload = (snapshots: SerializedFileSnapshot[]): SerializedHistory => ({
  version: 1,
  snapshots,
});

/**
 * Whether the recursive directory wipe (`clearAll` -> `rmdir(dir, true)`) was
 * issued against the shard directory at any point. The whole-vault wipe this
 * change forbids would surface here.
 */
const didRecursiveWipe = (adapter: MemoryAdapter): boolean =>
  adapter.calls.some((call): boolean => call.op === 'rmdir' && call.args[0] === SHARD_DIR && call.args[1] === 'true');

const DAY_MS: number = 24 * 60 * 60 * 1000;

describe('PersistenceService idle-vault no-wipe guard', () => {
  it('never wipes the shard dir when every live snapshot is older than maxAgeDays', async (): Promise<void> => {
    const adapter = new MemoryAdapter();
    const now: number = Date.now();
    // Every live file is 60 days old, well past the 30-day age cap. Pre-change,
    // retention returned [] and the save path nuked the entire shard directory.
    const snapshots: SerializedFileSnapshot[] = [
      entry('a.md', now - (60 * DAY_MS)),
      entry('b.md', now - (90 * DAY_MS)),
    ];

    const service = makeRetentionWriteService(
      adapter,
      (): SerializedHistory => multiPayload(snapshots),
      { maxEntries: 0, maxAgeDays: 30, maxDeletedEntries: 0, maxDeletedAgeDays: 30 },
    );

    service.triggerSave();
    await service.drain();

    // History survives: both shards on disk, no recursive directory wipe.
    expect(readShardSnapshot(adapter, 'a.md')).toBeDefined();
    expect(readShardSnapshot(adapter, 'b.md')).toBeDefined();
    expect(didRecursiveWipe(adapter)).toBe(false);
    expect(await adapter.exists(SHARD_DIR)).toBe(true);
  });

  it('still evicts the stalest live files when the count cap is exceeded', async (): Promise<void> => {
    const adapter = new MemoryAdapter();
    const now: number = Date.now();
    // Five live files, count cap of 2: only the two newest survive, the three
    // stalest are evicted per shard (not via a directory wipe).
    const snapshots: SerializedFileSnapshot[] = [
      entry('new.md', now - DAY_MS),
      entry('second.md', now - (2 * DAY_MS)),
      entry('third.md', now - (3 * DAY_MS)),
      entry('fourth.md', now - (4 * DAY_MS)),
      entry('fifth.md', now - (5 * DAY_MS)),
    ];

    const service = makeRetentionWriteService(
      adapter,
      (): SerializedHistory => multiPayload(snapshots),
      { maxEntries: 2, maxAgeDays: 0, maxDeletedEntries: 0, maxDeletedAgeDays: 0 },
    );

    service.triggerSave();
    await service.drain();

    expect(readShardSnapshot(adapter, 'new.md')).toBeDefined();
    expect(readShardSnapshot(adapter, 'second.md')).toBeDefined();
    expect(readShardSnapshot(adapter, 'third.md')).toBeUndefined();
    expect(readShardSnapshot(adapter, 'fourth.md')).toBeUndefined();
    expect(readShardSnapshot(adapter, 'fifth.md')).toBeUndefined();
    expect(didRecursiveWipe(adapter)).toBe(false);
  });

  it('still expires deleted-file tombstones by maxDeletedAgeDays', async (): Promise<void> => {
    const adapter = new MemoryAdapter();
    const now: number = Date.now();
    // A live file plus one fresh and one stale tombstone. With a 7-day deleted
    // age cap the stale tombstone is dropped while the live file and the fresh
    // tombstone persist.
    const snapshots: SerializedFileSnapshot[] = [
      entry('live.md', now - (60 * DAY_MS)),
      tombstone('fresh-dead.md', now - (60 * DAY_MS), now - DAY_MS),
      tombstone('stale-dead.md', now - (60 * DAY_MS), now - (30 * DAY_MS)),
    ];

    const service = makeRetentionWriteService(
      adapter,
      (): SerializedHistory => multiPayload(snapshots),
      { maxEntries: 0, maxAgeDays: 30, maxDeletedEntries: 0, maxDeletedAgeDays: 7 },
    );

    service.triggerSave();
    await service.drain();

    // Live file kept despite being 60 days old; fresh tombstone kept; stale
    // tombstone expired. No directory wipe.
    expect(readShardSnapshot(adapter, 'live.md')).toBeDefined();
    expect(readShardSnapshot(adapter, 'fresh-dead.md')).toBeDefined();
    expect(readShardSnapshot(adapter, 'stale-dead.md')).toBeUndefined();
    expect(didRecursiveWipe(adapter)).toBe(false);
  });

  it('still clears the disk for the genuinely-empty case (no in-memory snapshots)', async (): Promise<void> => {
    const adapter = new MemoryAdapter();
    // Seed a stale shard so the clear path has something to wipe.
    await adapter.write(
      shardPath('stale.md'),
      JSON.stringify({ version: 1, snapshot: entry('stale.md', 1) }),
    );

    const service = makeRetentionWriteService(
      adapter,
      // Empty in-memory state: the intended clear path must still run.
      (): SerializedHistory => multiPayload([]),
      { maxEntries: 0, maxAgeDays: 30, maxDeletedEntries: 0, maxDeletedAgeDays: 30 },
    );

    service.triggerSave();
    await service.drain();

    expect(readShardSnapshot(adapter, 'stale.md')).toBeUndefined();
    expect(await adapter.exists(SHARD_DIR)).toBe(false);
    expect(didRecursiveWipe(adapter)).toBe(true);
  });
});
