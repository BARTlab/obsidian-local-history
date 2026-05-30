import type { DataAdapter } from 'obsidian';

import type { SerializedShard } from '@/types';

/**
 * Stateless IO collaborator that owns the on-disk history shard directory
 * (Epic 10, ADR-10). It relocates the atomic `tmp -> bak -> rename` write that
 * the monolithic `history.json` used (`PersistenceService.saveToDisk`) down to
 * per-shard scope, so a crash mid-write loses at most one note's shard and never
 * a truncated file.
 *
 * The store holds no snapshot state and runs no debounce, queue, or retention:
 * those policies stay in {@link PersistenceService}, which serializes calls
 * through its own write queue. The store only knows the adapter and the resolved
 * shard directory path, mirroring the stateless-operator split of ADR-08.
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
