import 'reflect-metadata';
import { describe, expect, it, jest } from '@jest/globals';
import { KeepHistory, SAVE_DEBOUNCE_MS } from '@/consts';
import { PersistenceService } from '@/services/persistence.service';
import type { SerializedFileSnapshot, SerializedHistory } from '@/types';

/**
 * Tests for the retention caps in PersistenceService (T5.1). They drive the
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
  it('drops entries older than maxAgeDays', () => {
    const service = makeService(0, 7);
    const now: number = Date.now();

    const kept = service.prune([
      entry('fresh.md', now - (1 * DAY)),
      entry('stale.md', now - (30 * DAY)),
    ]);

    expect(kept.map((item: SerializedFileSnapshot): string => item.path)).toEqual(['fresh.md']);
  });

  it('keeps everything when maxAgeDays is 0 (disabled)', () => {
    const service = makeService(0, 0);
    const now: number = Date.now();

    const kept = service.prune([
      entry('old.md', now - (3650 * DAY)),
    ]);

    expect(kept).toHaveLength(1);
  });
});

describe('PersistenceService retention combined caps', () => {
  it('applies the age cap before the size cap', () => {
    const service = makeService(2, 7);
    const now: number = Date.now();

    const kept = service.prune([
      entry('new.md', now - DAY),
      entry('mid.md', now - (2 * DAY)),
      entry('expired.md', now - (10 * DAY)),
    ]);

    // expired.md is removed by age; the remaining two fit the size cap.
    expect(kept.map((item: SerializedFileSnapshot): string => item.path)).toEqual(['new.md', 'mid.md']);
  });

  it('returns an empty list for non-array input', () => {
    const service = makeService(10, 10);

    expect(service.prune(null as unknown as SerializedFileSnapshot[])).toEqual([]);
  });
});

describe('PersistenceService retention tombstone caps (T06)', () => {
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
 * Tests for the serialized + atomic + backed-up write pipeline (ADR-08-A,
 * task T03). They drive a tiny in-memory adapter that mirrors the Obsidian
 * `DataAdapter` surface used by `PersistenceService` (`exists`, `read`,
 * `write`, `rename`, `remove`) so the queue, atomic replace, and `.bak`
 * behaviour can be verified end-to-end without touching real disk.
 */

interface AdapterCall {
  readonly op: 'write' | 'rename' | 'remove' | 'exists' | 'read';
  readonly args: readonly string[];
}

class MemoryAdapter {
  public files: Map<string, string> = new Map<string, string>();

  public calls: AdapterCall[] = [];

  public writeDelay: number = 0;

  public failNextRename: boolean = false;

  public async exists(path: string): Promise<boolean> {
    this.calls.push({ op: 'exists', args: [path] });

    return this.files.has(path);
  }

  public async read(path: string): Promise<string> {
    this.calls.push({ op: 'read', args: [path] });

    const value: string | undefined = this.files.get(path);

    if (value === undefined) {
      throw new Error(`MemoryAdapter: missing ${path}`);
    }

    return value;
  }

  public async write(path: string, data: string): Promise<void> {
    this.calls.push({ op: 'write', args: [path] });

    if (this.writeDelay > 0) {
      await new Promise<void>((resolve: () => void): void => {
        setTimeout(resolve, this.writeDelay);
      });
    }

    this.files.set(path, data);
  }

  public async rename(from: string, to: string): Promise<void> {
    this.calls.push({ op: 'rename', args: [from, to] });

    if (this.failNextRename) {
      this.failNextRename = false;
      throw new Error('MemoryAdapter: rename failed');
    }

    const value: string | undefined = this.files.get(from);

    if (value === undefined) {
      throw new Error(`MemoryAdapter: cannot rename missing ${from}`);
    }

    this.files.set(to, value);
    this.files.delete(from);
  }

  public async remove(path: string): Promise<void> {
    this.calls.push({ op: 'remove', args: [path] });
    this.files.delete(path);
  }
}

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
      dir: '.obsidian/plugins/local-history',
      id: 'local-history',
    },
    forceUpdateEditor: (): void => {
      // no-op
    },
  } as unknown as PluginArg;

  return new WritePersistenceService(plugin);
};

const HISTORY_PATH: string = '.obsidian/plugins/local-history/history.json';

const payload = (path: string, timestamp: number): SerializedHistory => ({
  version: 1,
  snapshots: [
    {
      path,
      lineBreak: '\n',
      timestamp,
      lines: [],
      state: [],
      tracker: [],
    },
  ],
});

describe('PersistenceService write queue (ADR-08-A)', () => {
  it('serializes overlapping saves so the later payload wins on disk', async (): Promise<void> => {
    const adapter = new MemoryAdapter();
    let counter: number = 0;
    const service = makeWriteService(adapter, (): SerializedHistory => {
      counter += 1;

      return payload(`v${counter}.md`, counter);
    });

    // First save sees a slow write, second is enqueued before the first
    // finishes. With one queue the second must observe the first's output
    // already on disk (prior file copied to .bak before the second rename).
    adapter.writeDelay = 20;

    service.triggerSave();
    service.triggerSave();
    await service.drain();

    const final: string | undefined = adapter.files.get(HISTORY_PATH);
    expect(final).toBeDefined();

    const parsed: SerializedHistory = JSON.parse(final ?? '') as SerializedHistory;
    expect(parsed.snapshots[0].path).toBe('v2.md');

    // .bak holds the prior (first) write so the second write was not a clobber.
    const backup: string | undefined = adapter.files.get(`${HISTORY_PATH}.bak`);
    expect(backup).toBeDefined();
    const parsedBackup: SerializedHistory = JSON.parse(backup ?? '') as SerializedHistory;
    expect(parsedBackup.snapshots[0].path).toBe('v1.md');
  });

  it('unload awaits an in-flight save and the final state is persisted', async (): Promise<void> => {
    const adapter = new MemoryAdapter();
    const service = makeWriteService(adapter, (): SerializedHistory => payload('unload.md', 1));

    adapter.writeDelay = 15;
    service.triggerSave();

    await service.unload();

    expect(adapter.files.has(HISTORY_PATH)).toBe(true);
    const parsed: SerializedHistory = JSON.parse(adapter.files.get(HISTORY_PATH) ?? '') as SerializedHistory;
    expect(parsed.snapshots[0].path).toBe('unload.md');
  });

  it('writes atomically through .tmp + rename and produces a .bak of the prior file', async (): Promise<void> => {
    const adapter = new MemoryAdapter();
    let counter: number = 0;
    const service = makeWriteService(adapter, (): SerializedHistory => {
      counter += 1;

      return payload(`atom-${counter}.md`, counter);
    });

    service.triggerSave();
    await service.drain();
    // First write: tmp + rename, no prior file so no .bak.
    expect(adapter.files.has(HISTORY_PATH)).toBe(true);
    expect(adapter.files.has(`${HISTORY_PATH}.bak`)).toBe(false);
    expect(adapter.files.has(`${HISTORY_PATH}.tmp`)).toBe(false);

    service.triggerSave();
    await service.drain();
    // Second write: prior file exists, must have been moved to .bak.
    expect(adapter.files.has(`${HISTORY_PATH}.bak`)).toBe(true);
    const bak: SerializedHistory = JSON.parse(adapter.files.get(`${HISTORY_PATH}.bak`) ?? '') as SerializedHistory;
    expect(bak.snapshots[0].path).toBe('atom-1.md');
    const live: SerializedHistory = JSON.parse(adapter.files.get(HISTORY_PATH) ?? '') as SerializedHistory;
    expect(live.snapshots[0].path).toBe('atom-2.md');
  });

  it('clears the on-disk file even when persistence is disabled', async (): Promise<void> => {
    const adapter = new MemoryAdapter();
    adapter.files.set(HISTORY_PATH, JSON.stringify(payload('stale.md', 1)));

    const service = makeWriteService(
      adapter,
      (): SerializedHistory => payload('ignored.md', 1),
      { persist: false, keep: KeepHistory.app },
    );

    service.triggerClear();
    await service.drain();

    expect(adapter.files.has(HISTORY_PATH)).toBe(false);
  });

  it('debounced saves are coalesced and routed through the queue', async (): Promise<void> => {
    jest.useFakeTimers();
    try {
      const adapter = new MemoryAdapter();
      let calls: number = 0;
      const service = makeWriteService(adapter, (): SerializedHistory => {
        calls += 1;

        return payload(`debounced-${calls}.md`, calls);
      });

      service.onSnapshotsUpdate();
      service.onSnapshotsUpdate();
      service.onSnapshotsUpdate();

      jest.advanceTimersByTime(SAVE_DEBOUNCE_MS + 1);
      jest.useRealTimers();
      await service.drain();

      // Only one serialize call happened because the timer collapsed the three triggers.
      expect(calls).toBe(1);
      const live: SerializedHistory = JSON.parse(adapter.files.get(HISTORY_PATH) ?? '') as SerializedHistory;
      expect(live.snapshots[0].path).toBe('debounced-1.md');
    } finally {
      jest.useRealTimers();
    }
  });
});
