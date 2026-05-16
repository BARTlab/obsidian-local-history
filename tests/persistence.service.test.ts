import 'reflect-metadata';
import { describe, expect, it } from '@jest/globals';
import { PersistenceService } from '@/services/persistence.service';
import type { SerializedFileSnapshot } from '@/types';

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
