import type { DataAdapter } from 'obsidian';

import { ShardNameHelper } from '@/helpers/shard-name.helper';
import type { HistoryShardStore } from '@/persistence/history-shard-store';
import type { SerializedFileSnapshot, SerializedHistory } from '@/types';

/**
 * Owns the run-at-most-once migration of a legacy monolithic `history.json` into
 * per-note shards. The monolith is legacy: it is only ever read to migrate it,
 * so the whole read-validate-split-cleanup concern lives here rather than in
 * {@link PersistenceService}, which keeps only the shard-based restore/save
 * orchestration on its hot path.
 *
 * The migrator holds no persistent state: it reads the legacy file through the
 * adapter, writes each legacy snapshot as its own shard through the shard store,
 * and removes the legacy files once every shard has landed. A single instance is
 * constructed and driven once during restore.
 */
export class MonolithMigrator {
  /**
   * The vault-relative path of the legacy monolith. Its `.bak`/`.tmp` siblings
   * are derived from it: `.bak` is the crash-recovery source and both siblings
   * are removed alongside the primary after a successful migration.
   */
  protected readonly historyPath: string;

  /**
   * Creates a migrator bound to one adapter, one plugin directory, and one shard
   * store.
   *
   * @param {DataAdapter} adapter - The vault data adapter used to read and remove
   *   the legacy monolith files.
   * @param {string} pluginDir - The resolved (vault-relative) plugin directory
   *   that holds the legacy `history.json`.
   * @param {HistoryShardStore} store - The shard store the legacy snapshots are
   *   written into and probed against for the skip-when-already-sharded guard.
   */
  public constructor(
    protected adapter: DataAdapter,
    pluginDir: string,
    protected store: HistoryShardStore,
  ) {
    this.historyPath = `${pluginDir}/history.json`;
  }

  /**
   * Migrates a legacy monolithic `history.json` into per-note shards exactly once
   *. Runs only when the shard directory holds no shards yet but a
   * legacy file (or its `.bak`) still exists and parses: each legacy snapshot is
   * written as its own shard, then the legacy `history.json`/`.bak`/`.tmp` files
   * are removed. The shard `version` is carried through from the legacy file (no
   * re-encode), so a version-1 or version-2 monolith migrates byte-for-byte per
   * snapshot whether or not the delta codec has landed.
   *
   * Failure-safe: a write failure aborts before any legacy file is removed and
   * logs, so the legacy file stays intact and the next restore retries. Once
   * shards exist the legacy path is never consulted again (the guard sees a
   * non-empty shard dir and returns immediately).
   *
   * @return {Promise<void>} Resolves once migration ran or was skipped
   */
  public async migrate(): Promise<void> {
    /**
     * Skip migration the moment any shard exists: the shard dir is the source of
     * truth, so a single prior shard means migration already happened (or the
     * store is the live store) and the legacy path must never be reconsulted.
     */
    if ((await this.store.listNames()).size > 0) {
      return;
    }

    const legacy: SerializedHistory | null = await this.readLegacy();

    if (!legacy || legacy.snapshots.length === 0) {
      return;
    }

    const taken: Set<string> = new Set();

    try {
      for (const snapshot of legacy.snapshots) {
        const name: string = ShardNameHelper.allocate(snapshot.path, taken);

        taken.add(name);

        await this.store.writeShard(name, { version: legacy.version, snapshot });
      }
    } catch (error) {
      /**
       * A write failed mid-migration. Leave the legacy file in place (no removal
       * happens below) so the next restore retries; any partial shards written so
       * far are harmless because the legacy file remains the recovery source until
       * a full migration succeeds.
       */
      console.error('Local history: failed to migrate legacy history into shards', error);

      return;
    }

    /**
     * All shards landed: remove the legacy monolith and its atomic-write siblings
     * so the one-time migration never runs again and disabled never resurfaces
     * stale data.
     */
    await this.removeLegacy();
  }

  /**
   * Reads and parses the legacy on-disk monolith, the one-time migration source
   *. Tries the primary `history.json` first and falls back to its
   * `.bak` sibling so a crash between the monolith's old `tmp -> bak -> rename`
   * steps still yields a usable source. Returns null when neither variant is
   * present or parses, so the migration caller treats a missing/corrupt monolith
   * as "nothing to migrate" rather than throwing.
   *
   * Per-entry validation: each snapshot is checked against a minimal
   * shape predicate (`isValidEntry`) and malformed entries are skipped so a few
   * bad records do not poison retention math (`NaN >= oldest` is always false,
   * silently dropping otherwise-valid entries) or crash downstream
   * `SnapshotCodec.decode`.
   *
   * @return {Promise<SerializedHistory | null>} The parsed history, or null
   */
  protected async readLegacy(): Promise<SerializedHistory | null> {
    for (const candidate of [this.historyPath, `${this.historyPath}.bak`]) {
      const parsed: SerializedHistory | null = await this.readVariant(candidate);

      if (parsed !== null) {
        return parsed;
      }
    }

    return null;
  }

  /**
   * Reads and validates one legacy monolith variant (`history.json` or its
   * `.bak`). Returns null when the file is absent, unreadable, not JSON, or has
   * no `snapshots` array so {@link readLegacy} can fall through to the next
   * variant. Never throws.
   *
   * @param {string} path - The full vault-relative path of the variant
   * @return {Promise<SerializedHistory | null>} The parsed history, or null
   */
  protected async readVariant(path: string): Promise<SerializedHistory | null> {
    try {
      if (!(await this.adapter.exists(path))) {
        return null;
      }

      const raw: string = await this.adapter.read(path);
      const parsed: SerializedHistory = JSON.parse(raw) as SerializedHistory;

      if (!parsed || !Array.isArray(parsed.snapshots)) {
        return null;
      }

      const valid: SerializedFileSnapshot[] = parsed.snapshots.filter(
        (item: SerializedFileSnapshot): boolean => this.isValidEntry(item),
      );

      return { version: parsed.version, snapshots: valid };
    } catch (error) {
      console.error('Local history: failed to read persisted history', error);

      return null;
    }
  }

  /**
   * Whether a serialized snapshot has the minimum well-formed shape required to
   * survive retention math and reach `SnapshotCodec.decode` without falling
   * back to defaults that would resurrect junk. Required: `path` is a string,
   * `timestamp` is a finite number, `lines` and `tracker` are arrays. A
   * non-finite timestamp is treated as "skip" rather than `0` so a malformed
   * entry cannot pose as fresh history.
   *
   * @param {SerializedFileSnapshot} item - The candidate entry
   * @return {boolean} True when the entry is structurally usable
   */
  protected isValidEntry(item: SerializedFileSnapshot): boolean {
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
   * Removes the legacy monolithic `history.json` and its `.bak`/`.tmp` siblings
   * after a successful migration. Best-effort and idempotent: a missing variant
   * is fine and a per-variant failure is logged, not thrown, so a stubborn file
   * cannot abort restore once the shards are already on disk.
   *
   * @return {Promise<void>} Resolves once all present legacy variants are gone
   */
  protected async removeLegacy(): Promise<void> {
    for (const candidate of [this.historyPath, `${this.historyPath}.bak`, `${this.historyPath}.tmp`]) {
      try {
        if (await this.adapter.exists(candidate)) {
          await this.adapter.remove(candidate);
        }
      } catch (error) {
        console.error('Local history: failed to remove legacy history file', candidate, error);
      }
    }
  }
}
