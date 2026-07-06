import { describe, expect, it } from 'vitest';
import type { DataAdapter } from 'obsidian';
import { HISTORY_SHARD_DIR } from '@/consts';
import * as ShardNameHelper from '@/helpers/shard-name.helper';
import { HistoryShardStore } from '@/persistence/history-shard-store';
import { MonolithMigrator } from '@/persistence/monolith-migrator';
import type { SerializedFileSnapshot, SerializedHistory, SerializedShard } from '@/types';

import { MemoryAdapter } from './stubs/memory-adapter';

/**
 * Tests for the one-time monolith-to-shard migrator extracted from
 * PersistenceService. Two concerns are covered directly against the shared
 * dir-aware `MemoryAdapter`: the per-entry validation of a legacy monolith read
 * (formerly the service's `readDisk` suite) and the migrate happy path plus the
 * skip-when-already-sharded guard, without any Obsidian dependency or real disk.
 */

const PLUGIN_DIR: string = '.obsidian/plugins/local-history';

const HISTORY_PATH: string = `${PLUGIN_DIR}/history.json`;

const SHARD_DIR: string = `${PLUGIN_DIR}/${HISTORY_SHARD_DIR}`;

/**
 * Resolves the on-disk shard file path for a note path the same way the store
 * does (path hash + `.json` under the shard dir), so tests assert against real
 * shard filenames without hardcoding any hash.
 */
const shardPath = (notePath: string): string => `${SHARD_DIR}/${ShardNameHelper.forPath(notePath)}`;

/**
 * Test-only subclass exposing the protected legacy read so the per-entry
 * validation can be asserted directly, the same contract the service's former
 * `readDisk` suite exercised.
 */
class TestMonolithMigrator extends MonolithMigrator {
  public read(): Promise<SerializedHistory | null> {
    return this.readLegacy();
  }
}

/**
 * Builds a migrator and its shard store over one shared in-memory adapter, both
 * resolved against the same plugin directory the service would resolve.
 */
const makeMigrator = (adapter: MemoryAdapter): TestMonolithMigrator => {
  const store: HistoryShardStore = new HistoryShardStore(adapter as unknown as DataAdapter, SHARD_DIR);

  return new TestMonolithMigrator(adapter as unknown as DataAdapter, PLUGIN_DIR, store);
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

describe('MonolithMigrator legacy read per-entry validation', () => {
  it('skips entries missing a finite timestamp and keeps the valid ones', async (): Promise<void> => {
    const adapter = new MemoryAdapter();
    const now: number = Date.now();
    adapter.files.set(HISTORY_PATH, JSON.stringify({
      version: 1,
      snapshots: [
        entry('good.md', now),
        // Missing timestamp: must be skipped, not coerced to 0.
        { path: 'bad-no-ts.md', lineBreak: '\n', lines: [], state: [], tracker: [] },
        // Non-finite timestamp (NaN serializes to null; tested through both forms).
        { path: 'bad-nan.md', lineBreak: '\n', timestamp: null, lines: [], state: [], tracker: [] },
        entry('good-2.md', now - 1000),
      ],
    }));

    const result: SerializedHistory | null = await makeMigrator(adapter).read();

    expect(result).not.toBeNull();
    const paths: string[] = (result?.snapshots ?? []).map(
      (item: SerializedFileSnapshot): string => item.path,
    );

    expect(paths).toEqual(['good.md', 'good-2.md']);
  });

  it('returns the original set unchanged when every entry is valid', async (): Promise<void> => {
    const adapter = new MemoryAdapter();
    const now: number = Date.now();
    const snapshots: SerializedFileSnapshot[] = [
      entry('a.md', now),
      entry('b.md', now - 1000),
      entry('c.md', now - 2000),
    ];

    adapter.files.set(HISTORY_PATH, JSON.stringify({ version: 1, snapshots }));

    const result: SerializedHistory | null = await makeMigrator(adapter).read();

    expect(result).not.toBeNull();
    expect(result?.snapshots).toHaveLength(3);
    expect(
      (result?.snapshots ?? []).map((item: SerializedFileSnapshot): string => item.path),
    ).toEqual(['a.md', 'b.md', 'c.md']);
  });

  it('returns an empty snapshots array when every entry is malformed (no crash)', async (): Promise<void> => {
    const adapter = new MemoryAdapter();
    adapter.files.set(HISTORY_PATH, JSON.stringify({
      version: 1,
      snapshots: [
        null,
        { /* empty */ },
        { path: 123, timestamp: 1, lines: [], tracker: [] },
        { path: 'missing-arrays.md', timestamp: 1 },
        { path: 'bad-tracker.md', timestamp: 1, lines: [], tracker: 'oops' },
      ],
    }));

    const result: SerializedHistory | null = await makeMigrator(adapter).read();

    expect(result).not.toBeNull();
    expect(result?.snapshots).toEqual([]);
  });

  it('rejects entries whose lines or tracker fields are not arrays', async (): Promise<void> => {
    const adapter = new MemoryAdapter();
    const now: number = Date.now();
    adapter.files.set(HISTORY_PATH, JSON.stringify({
      version: 1,
      snapshots: [
        entry('good.md', now),
        { path: 'bad-lines.md', timestamp: now, lines: 'oops', tracker: [] },
        { path: 'bad-tracker.md', timestamp: now, lines: [], tracker: { not: 'an array' } },
      ],
    }));

    const result: SerializedHistory | null = await makeMigrator(adapter).read();

    const paths: string[] = (result?.snapshots ?? []).map(
      (item: SerializedFileSnapshot): string => item.path,
    );

    expect(paths).toEqual(['good.md']);
  });

  it('reads from the .bak sibling when the primary monolith is absent', async (): Promise<void> => {
    const adapter = new MemoryAdapter();
    const now: number = Date.now();
    adapter.files.set(`${HISTORY_PATH}.bak`, JSON.stringify({
      version: 2,
      snapshots: [entry('only.md', now)],
    }));

    const result: SerializedHistory | null = await makeMigrator(adapter).read();

    expect(result?.version).toBe(2);
    expect((result?.snapshots ?? []).map((item: SerializedFileSnapshot): string => item.path)).toEqual(['only.md']);
  });
});

describe('MonolithMigrator migrate', () => {
  it('splits a legacy monolith into one shard per snapshot and removes the legacy files', async (): Promise<void> => {
    const adapter = new MemoryAdapter();
    const now: number = Date.now();
    adapter.files.set(HISTORY_PATH, JSON.stringify({
      version: 2,
      snapshots: [entry('a.md', now), entry('b.md', now - 1000)],
    }));

    await makeMigrator(adapter).migrate();

    expect(readShardSnapshot(adapter, 'a.md')?.path).toBe('a.md');
    expect(readShardSnapshot(adapter, 'b.md')?.path).toBe('b.md');
    // The shard version is carried through from the legacy file, not re-encoded.
    expect((JSON.parse(adapter.files.get(shardPath('a.md')) ?? '') as SerializedShard).version).toBe(2);
    // The legacy monolith and its atomic-write siblings are gone after migration.
    expect(adapter.files.has(HISTORY_PATH)).toBe(false);
    expect(adapter.files.has(`${HISTORY_PATH}.bak`)).toBe(false);
    expect(adapter.files.has(`${HISTORY_PATH}.tmp`)).toBe(false);
  });

  it('skips migration and leaves the legacy file intact when a shard already exists', async (): Promise<void> => {
    const adapter = new MemoryAdapter();
    const now: number = Date.now();
    const existingShard: SerializedShard = { version: 1, snapshot: entry('existing.md', now) };
    await adapter.write(shardPath('existing.md'), JSON.stringify(existingShard));

    adapter.files.set(HISTORY_PATH, JSON.stringify({
      version: 1,
      snapshots: [entry('legacy.md', now - 1000)],
    }));

    await makeMigrator(adapter).migrate();

    // The pre-existing shard means migration already happened; the legacy file is
    // never reconsulted, never split, and never removed.
    expect(adapter.files.has(HISTORY_PATH)).toBe(true);
    expect(adapter.files.has(shardPath('legacy.md'))).toBe(false);
  });
});
