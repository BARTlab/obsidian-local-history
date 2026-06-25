import { describe, expect, it } from '@jest/globals';
import type { DataAdapter } from 'obsidian';

import { HistoryShardStore } from '@/persistence/history-shard-store';
import type { LoadedShard } from '@/persistence/history-shard-store';
import type { SerializedFileSnapshot, SerializedShard } from '@/types';

import { MemoryAdapter } from './stubs/memory-adapter';

/**
 * Unit tests for the stateless `HistoryShardStore` IO collaborator. They drive the
 * store against the shared in-memory adapter so the per-shard atomic write, the
 * `.json -> .bak -> .tmp` read fallback, removal, directory wipe, and name
 * enumeration are verified in isolation, without a real filesystem.
 */

const DIR: string = 'history';

/**
 * Builds a minimal structurally valid serialized snapshot for the given path,
 * enough to pass the store's `isValidShard` predicate (string path, finite
 * timestamp, `lines`/`tracker` arrays).
 *
 * @param {string} path - The vault-relative note path the snapshot is keyed by.
 * @return {SerializedFileSnapshot} A well-formed serialized snapshot.
 */
function makeSnapshot(path: string): SerializedFileSnapshot {
  return {
    path,
    lineBreak: '\n',
    timestamp: 1_700_000_000_000,
    lines: ['line one', 'line two'],
    state: [],
    tracker: [],
  };
}

/**
 * Wraps a snapshot in a self-describing shard at the given format version.
 *
 * @param {string} path - The note path for the embedded snapshot.
 * @param {number} version - The on-disk format version to stamp.
 * @return {SerializedShard} The shard payload to persist.
 */
function makeShard(path: string, version: number = 1): SerializedShard {
  return { version, snapshot: makeSnapshot(path) };
}

/**
 * Builds a store bound to a fresh adapter, returning both so a test can assert
 * on disk state and the recorded call log.
 *
 * @return {{ adapter: MemoryAdapter; store: HistoryShardStore }} The pair.
 */
function makeStore(): { adapter: MemoryAdapter; store: HistoryShardStore } {
  const adapter: MemoryAdapter = new MemoryAdapter();
  const store: HistoryShardStore = new HistoryShardStore(adapter as unknown as DataAdapter, DIR);

  return { adapter, store };
}

describe('MemoryAdapter directory support', () => {
  it('lists a written shard under its directory', async () => {
    const adapter: MemoryAdapter = new MemoryAdapter();

    await adapter.write(`${DIR}/ab12.json`, '{}');

    const listed = await adapter.list(DIR);

    expect(listed.files).toContain(`${DIR}/ab12.json`);
  });

  it('reports an explicitly created empty directory as existing', async () => {
    const adapter: MemoryAdapter = new MemoryAdapter();

    expect(await adapter.exists(DIR)).toBe(false);

    await adapter.mkdir(DIR);

    expect(await adapter.exists(DIR)).toBe(true);
  });

  it('recursively removes a directory and its files', async () => {
    const adapter: MemoryAdapter = new MemoryAdapter();

    await adapter.write(`${DIR}/a.json`, '{}');
    await adapter.write(`${DIR}/b.json`, '{}');

    await adapter.rmdir(DIR, true);

    expect(await adapter.exists(DIR)).toBe(false);
    expect(adapter.files.size).toBe(0);
  });
});

describe('HistoryShardStore', () => {
  it('round-trips a shard through writeShard and readAll', async () => {
    const { store } = makeStore();
    const shard: SerializedShard = makeShard('notes/todo.md');

    await store.writeShard('ab12.json', shard);

    const loaded: LoadedShard[] = await store.readAll();

    expect(loaded).toHaveLength(1);
    expect(loaded[0].name).toBe('ab12.json');
    expect(loaded[0].shard).toEqual(shard);
  });

  it('reads each shard version through unchanged', async () => {
    const { store } = makeStore();

    await store.writeShard('aa.json', makeShard('a.md', 2));

    const loaded: LoadedShard[] = await store.readAll();

    expect(loaded[0].shard.version).toBe(2);
  });

  it('returns [] when the shard directory is absent', async () => {
    const { store } = makeStore();

    expect(await store.readAll()).toEqual([]);
  });

  it('recovers from .bak when the primary shard is corrupt', async () => {
    const { adapter, store } = makeStore();
    const good: SerializedShard = makeShard('notes/keep.md');

    await adapter.mkdir(DIR);
    await adapter.write(`${DIR}/cc.json`, '{ not valid json');
    await adapter.write(`${DIR}/cc.json.bak`, JSON.stringify(good));

    const recovered: SerializedShard | null = await store.readShard('cc.json');

    expect(recovered).toEqual(good);

    const loaded: LoadedShard[] = await store.readAll();

    expect(loaded).toHaveLength(1);
    expect(loaded[0].shard).toEqual(good);
  });

  it('recovers from .tmp when primary and .bak are both gone', async () => {
    const { adapter, store } = makeStore();
    const good: SerializedShard = makeShard('notes/interrupted.md');

    await adapter.mkdir(DIR);
    await adapter.write(`${DIR}/dd.json.tmp`, JSON.stringify(good));

    const recovered: SerializedShard | null = await store.readShard('dd.json');

    expect(recovered).toEqual(good);

    const loaded: LoadedShard[] = await store.readAll();

    expect(loaded).toHaveLength(1);
    expect(loaded[0].name).toBe('dd.json');
    expect(loaded[0].shard).toEqual(good);
  });

  it('drops a shard with no readable variant', async () => {
    const { adapter, store } = makeStore();

    await adapter.mkdir(DIR);
    await adapter.write(`${DIR}/ee.json`, 'garbage');

    expect(await store.readAll()).toEqual([]);
  });

  it('backs up the prior shard to .bak on overwrite', async () => {
    const { adapter, store } = makeStore();
    const first: SerializedShard = makeShard('notes/n.md', 1);
    const second: SerializedShard = makeShard('notes/n.md', 2);

    await store.writeShard('ff.json', first);
    await store.writeShard('ff.json', second);

    expect(JSON.parse(adapter.files.get(`${DIR}/ff.json`) as string)).toEqual(second);
    expect(JSON.parse(adapter.files.get(`${DIR}/ff.json.bak`) as string)).toEqual(first);
  });

  it('removes every variant of a shard via removeShard', async () => {
    const { adapter, store } = makeStore();

    await adapter.mkdir(DIR);
    await adapter.write(`${DIR}/gg.json`, '{}');
    await adapter.write(`${DIR}/gg.json.bak`, '{}');
    await adapter.write(`${DIR}/gg.json.tmp`, '{}');

    await store.removeShard('gg.json');

    expect(adapter.files.has(`${DIR}/gg.json`)).toBe(false);
    expect(adapter.files.has(`${DIR}/gg.json.bak`)).toBe(false);
    expect(adapter.files.has(`${DIR}/gg.json.tmp`)).toBe(false);
  });

  it('removeShard on an absent shard is a no-op', async () => {
    const { store } = makeStore();

    await expect(store.removeShard('missing.json')).resolves.toBeUndefined();
  });

  it('wipes the whole shard directory via clearAll', async () => {
    const { adapter, store } = makeStore();

    await store.writeShard('h1.json', makeShard('a.md'));
    await store.writeShard('h2.json', makeShard('b.md'));

    await store.clearAll();

    expect(await adapter.exists(DIR)).toBe(false);
    expect((await store.readAll())).toEqual([]);
  });

  it('clearAll is a no-op when the directory is absent', async () => {
    const { store } = makeStore();

    await expect(store.clearAll()).resolves.toBeUndefined();
  });

  it('lists base names via listNames, folding orphan .bak/.tmp to the primary', async () => {
    const { adapter, store } = makeStore();

    await store.writeShard('p1.json', makeShard('a.md'));
    await adapter.mkdir(DIR);
    await adapter.write(`${DIR}/p2.json.bak`, JSON.stringify(makeShard('b.md')));
    await adapter.write(`${DIR}/p3.json.tmp`, JSON.stringify(makeShard('c.md')));

    const names: Set<string> = await store.listNames();

    expect(names).toEqual(new Set<string>(['p1.json', 'p2.json', 'p3.json']));
  });

  it('listNames returns an empty set when the directory is absent', async () => {
    const { store } = makeStore();

    expect(await store.listNames()).toEqual(new Set<string>());
  });
});
