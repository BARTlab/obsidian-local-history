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
 * there.
 */
const makeService = (maxEntries: number, maxAgeDays: number): TestPersistenceService => {
  const settings = {
    value: (path: string): number => {
      if (path === 'retention.maxEntries') {
        return maxEntries;
      }

      if (path === 'retention.maxAgeDays') {
        return maxAgeDays;
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
