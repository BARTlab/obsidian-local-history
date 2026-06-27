import type { DataAdapter, ListedFiles } from 'obsidian';

import type { SerializedFileSnapshot, SerializedShard } from '@/types';

/**
 * One enumerated shard: its on-disk filename (the read-time index key) paired
 * with the parsed, validated payload. `readAll` returns these so the caller can
 * seed its in-memory path-to-shard index without re-listing.
 */
export interface LoadedShard {
  name: string;
  shard: SerializedShard;
}

/**
 * Stateless IO collaborator that owns the on-disk history shard directory
 * (ADR-10). It relocates the atomic `tmp -> bak -> rename` write that
 * the monolithic `history.json` used (`PersistenceService.saveToDisk`) down to
 * per-shard scope, so a crash mid-write loses at most one note's shard and never
 * a truncated file.
 *
 * The store holds no snapshot state and runs no debounce, queue, or retention:
 * those policies stay in {@link PersistenceService}, which serializes calls
 * through its own write queue. The store only knows the adapter and the resolved
 * shard directory path, mirroring the stateless-operator split of ADR-8.
 */
export class HistoryShardStore {
  /**
   * Creates a shard store bound to one adapter and one resolved shard directory.
   *
   * @param {DataAdapter} adapter - The vault data adapter used for all IO.
   * @param {string} dir - The resolved (vault-relative) shard directory path.
   */
  public constructor(
    protected adapter: DataAdapter,
    protected dir: string,
  ) {
  }

  /**
   * Writes one shard atomically, replacing any prior shard of the same name.
   *
   * The mechanic mirrors the former monolithic write at shard granularity:
   * ensure the shard directory exists, write the payload to `<name>.tmp`, back
   * up an existing `<name>` to `<name>.bak` (best-effort: a backup failure is
   * logged, not thrown, so it cannot abort the write), then `rename(tmp -> name)`
   * to swap the new content in atomically. A crash between steps leaves either
   * the prior file intact or the new `.tmp` recoverable, never a truncated shard.
   *
   * On a write failure the orphan `.tmp` is cleaned up best-effort and the error
   * is rethrown so the caller's write queue can observe and log it, matching the
   * service's existing failure handling.
   *
   * @param {string} name - The shard filename (e.g. `<hex>.json`).
   * @param {SerializedShard} shard - The self-describing shard payload to write.
   * @return {Promise<void>} Resolves once the new shard is in place.
   */
  public async writeShard(name: string, shard: SerializedShard): Promise<void> {
    await this.ensureDir();

    const path: string = this.shardPath(name);
    const tmpPath: string = `${path}.tmp`;
    const bakPath: string = `${path}.bak`;

    try {
      await this.adapter.write(tmpPath, JSON.stringify(shard));

      /**
       * Best-effort backup of the prior shard before replacing it. A missing
       * prior file is fine (first write); a backup failure must not abort the
       * write, so it is logged and ignored.
       */
      if (await this.adapter.exists(path)) {
        try {
          if (await this.adapter.exists(bakPath)) {
            await this.adapter.remove(bakPath);
          }

          await this.adapter.rename(path, bakPath);
        } catch (error) {
          console.error('Local history: failed to back up prior history shard', error);
        }
      }

      await this.adapter.rename(tmpPath, path);
    } catch (error) {
      /**
       * Clean up the orphan tmp file so it does not accumulate on repeated
       * failures, then rethrow so the caller's write queue logs and accounts
       * for the failure (the queue swallows it to avoid poisoning later writes).
       */
      try {
        if (await this.adapter.exists(tmpPath)) {
          await this.adapter.remove(tmpPath);
        }
      } catch {
        // Ignored: tmp cleanup is best-effort.
      }

      throw error;
    }
  }

  /**
   * Reads every shard back into memory by enumerating the shard directory, which
   * is the source of truth (ADR-10): there is no manifest, so a missing
   * shard simply is not listed and a corrupt one degrades exactly one note. Each
   * base name is recovered through {@link readShard}'s `.json -> .bak -> .tmp`
   * fallback, so a crash between the write's rename steps never loses a note.
   *
   * An absent directory yields `[]` (no history yet, not an error). Orphan
   * `.bak`/`.tmp` siblings whose primary `.json` is gone are still picked up so a
   * shard interrupted mid-write is not abandoned. Nulls (no readable variant)
   * are dropped, leaving only structurally valid shards.
   *
   * @return {Promise<LoadedShard[]>} Every readable shard with its filename.
   */
  public async readAll(): Promise<LoadedShard[]> {
    if (!(await this.adapter.exists(this.dir))) {
      return [];
    }

    let listed: ListedFiles;

    try {
      listed = await this.adapter.list(this.dir);
    } catch (error) {
      console.error('Local history: failed to list history shard directory', error);

      return [];
    }

    const names: string[] = this.shardNames(listed.files);
    const loaded: LoadedShard[] = [];

    for (const name of names) {
      const shard: SerializedShard | null = await this.readShard(name);

      if (shard !== null) {
        loaded.push({ name, shard });
      }
    }

    return loaded;
  }

  /**
   * Reads one shard by its base name, trying `<name>` first and falling back to
   * the `.bak` then `.tmp` siblings, returning the first variant that parses
   * into a structurally valid {@link SerializedShard}. Never throws: a missing,
   * unreadable, or malformed file is treated as "this variant is absent" so a
   * corrupt shard isolates to one note instead of poisoning the whole load.
   *
   * @param {string} name - The shard base filename (e.g. `<hex>.json`).
   * @return {Promise<SerializedShard | null>} The first valid shard, or null.
   */
  public async readShard(name: string): Promise<SerializedShard | null> {
    const path: string = this.shardPath(name);

    for (const candidate of [path, `${path}.bak`, `${path}.tmp`]) {
      const shard: SerializedShard | null = await this.readVariant(candidate);

      if (shard !== null) {
        return shard;
      }
    }

    return null;
  }

  /**
   * Removes one shard by base name, deleting its `<name>`, `<name>.bak`, and
   * `<name>.tmp` variants if present. Used by the policy layer
   * to evict a shard whose snapshot fell out of retention's kept set. Best-effort
   * and idempotent: a missing variant is fine and a per-variant failure is logged,
   * not thrown, so reconciling the index against disk can never abort on one
   * stubborn file.
   *
   * @param {string} name - The shard base filename (e.g. `<hex>.json`).
   * @return {Promise<void>} Resolves once all present variants are removed.
   */
  public async removeShard(name: string): Promise<void> {
    const path: string = this.shardPath(name);

    for (const candidate of [path, `${path}.bak`, `${path}.tmp`]) {
      try {
        if (await this.adapter.exists(candidate)) {
          await this.adapter.remove(candidate);
        }
      } catch (error) {
        console.error('Local history: failed to remove history shard variant', candidate, error);
      }
    }
  }

  /**
   * Wipes the whole shard directory, used when persistence is disabled or there
   * is nothing left to keep. Mirrors the monolith's `clearDisk`
   * (`PersistenceService`) at directory scope: remove the dir recursively if it
   * exists, swallowing and logging any failure rather than throwing, so disabling
   * persistence never surfaces an error to the caller.
   *
   * @return {Promise<void>} Resolves once the directory is gone (or was absent).
   */
  public async clearAll(): Promise<void> {
    try {
      if (await this.adapter.exists(this.dir)) {
        await this.adapter.rmdir(this.dir, true);
      }
    } catch (error) {
      console.error('Local history: failed to clear history shard directory', error);
    }
  }

  /**
   * Lists the base shard names currently on disk, derived from the directory
   * enumeration (the source of truth, ADR-10) the same way {@link readAll}
   * does, so an orphan `.bak`/`.tmp` maps back to its primary name and is reported
   * once. Lets the policy layer reconcile its in-memory path-to-shard index
   * against disk without reading shard contents. An absent directory yields an
   * empty set; never throws.
   *
   * @return {Promise<Set<string>>} The set of base shard names present on disk.
   */
  public async listNames(): Promise<Set<string>> {
    if (!(await this.adapter.exists(this.dir))) {
      return new Set<string>();
    }

    try {
      const listed: ListedFiles = await this.adapter.list(this.dir);

      return new Set<string>(this.shardNames(listed.files));
    } catch (error) {
      console.error('Local history: failed to list history shard directory', error);

      return new Set<string>();
    }
  }

  /**
   * Reads and validates a single shard-file variant. Returns null when the file
   * is absent, unreadable, not JSON, or not a structurally valid shard, so the
   * caller can fall through to the next variant. Never throws.
   *
   * @param {string} path - The full vault-relative path of the variant.
   * @return {Promise<SerializedShard | null>} The valid shard, or null.
   */
  protected async readVariant(path: string): Promise<SerializedShard | null> {
    try {
      if (!(await this.adapter.exists(path))) {
        return null;
      }

      const raw: string = await this.adapter.read(path);
      const parsed: unknown = JSON.parse(raw);

      return this.isValidShard(parsed) ? parsed : null;
    } catch (error) {
      console.error('Local history: failed to read history shard variant', path, error);

      return null;
    }
  }

  /**
   * Derives the de-duplicated set of shard base names from a directory listing.
   * `adapter.list` returns full vault-relative paths in `files`; this strips the
   * directory prefix to a base name and maps any `.bak`/`.tmp` sibling back to
   * its primary `<name>` so an orphaned variant (primary lost mid-write) is still
   * enumerated exactly once.
   *
   * @param {string[]} files - The `files` entries from a directory listing.
   * @return {string[]} The unique shard base names to attempt.
   */
  protected shardNames(files: string[]): string[] {
    const names: Set<string> = new Set();

    for (const file of files) {
      const base: string = file.slice(file.lastIndexOf('/') + 1);
      const name: string = base.replace(/\.(?:bak|tmp)$/, '');

      names.add(name);
    }

    return [...names];
  }

  /**
   * Whether a parsed value is a structurally usable {@link SerializedShard}: a
   * numeric `version` and a `snapshot` whose minimal shape (path string, finite
   * timestamp, `lines`/`tracker` arrays) survives retention math and reaches
   * `FileSnapshot.fromJSON` without resurrecting junk. This mirrors the
   * per-entry predicate that the monolithic `readDisk` applied, now
   * at shard granularity.
   *
   * @param {unknown} value - The parsed shard candidate.
   * @return {value is SerializedShard} True when the shard is usable.
   */
  protected isValidShard(value: unknown): value is SerializedShard {
    if (!value || typeof value !== 'object') {
      return false;
    }

    const shard: Partial<SerializedShard> = value as Partial<SerializedShard>;

    if (typeof shard.version !== 'number' || !Number.isFinite(shard.version)) {
      return false;
    }

    return this.isValidSnapshot(shard.snapshot);
  }

  /**
   * Whether a serialized snapshot has the minimum well-formed shape required to
   * survive retention math and reach `FileSnapshot.fromJSON`. Required: `path` is
   * a string, `timestamp` is a finite number, `lines` and `tracker` are arrays.
   * A non-finite timestamp is rejected so a malformed entry cannot pose as fresh
   * history.
   *
   * @param {SerializedFileSnapshot | undefined} item - The candidate snapshot.
   * @return {boolean} True when the snapshot is structurally usable.
   */
  protected isValidSnapshot(item: SerializedFileSnapshot | undefined): boolean {
    if (!item || typeof item !== 'object') {
      return false;
    }

    if (typeof item.path !== 'string') {
      return false;
    }

    if (typeof item.timestamp !== 'number' || !Number.isFinite(item.timestamp)) {
      return false;
    }

    return Array.isArray(item.lines) && Array.isArray(item.tracker);
  }

  /**
   * Resolves the vault-relative path of a shard by its filename.
   *
   * @param {string} name - The shard filename.
   * @return {string} The full path inside the shard directory.
   */
  protected shardPath(name: string): string {
    return `${this.dir}/${name}`;
  }

  /**
   * Ensures the shard directory exists, creating it on demand. An "already
   * exists" failure is swallowed because `mkdir` on an existing directory is a
   * no-op intent: there is no portable pre-check across the desktop and mobile
   * adapters, so creating-then-ignoring is the cheapest correct path.
   *
   * @return {Promise<void>} Resolves once the directory is present.
   */
  protected async ensureDir(): Promise<void> {
    try {
      await this.adapter.mkdir(this.dir);
    } catch {
      // Ignored: the directory most likely already exists.
    }
  }
}
