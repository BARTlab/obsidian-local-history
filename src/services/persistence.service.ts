import { HISTORY_SHARD_DIR, KeepHistory, PluginEvent, SAVE_DEBOUNCE_MS } from '@/consts';
import { Inject } from '@/decorators/inject.decorator';
import { On } from '@/decorators/on.decorator';
import { ShardNameHelper } from '@/helpers/shard-name.helper';
import type LineChangeTrackerPlugin from '@/main';
import { AsyncSaveQueue } from '@/persistence/async-save-queue';
import { HistoryShardStore, type LoadedShard } from '@/persistence/history-shard-store';
import { MonolithMigrator } from '@/persistence/monolith-migrator';
import { RetentionPolicy, type RetentionCaps } from '@/persistence/retention-policy';
import type { SettingsService } from '@/services/settings.service';
import type { SnapshotsService } from '@/services/snapshots.service';
import { TOKENS } from '@/services/tokens';
import type { SerializedFileSnapshot, SerializedHistory, Service } from '@/types';

/**
 * One in-memory index entry for a persisted shard: the on-disk filename to write
 * or remove it under, and a >=64-bit content digest of its serialized snapshot.
 * The save path diffs the live digest against this to write only
 * changed shards, and reuses `name` for collision-aware naming so two distinct
 * notes never share a filename.
 */
interface ShardIndexEntry {
  name: string;
  digest: string;
}

/**
 * Service responsible for persisting file history to disk so it survives an
 * Obsidian restart. History is stored in a dedicated JSON file inside the
 * plugin folder (kept separate from settings, which live in data.json) and is
 * only read or written when the "persist history" setting is enabled and the
 * retention policy keeps history beyond a file close.
 *
 * @implements {Service}
 */
export class PersistenceService implements Service {
  /** Service for accessing plugin settings (persist flag and retention caps). */
  @Inject(TOKENS.settings)
  protected settingsService!: SettingsService;

  /** Service holding the in-memory snapshots to serialize and restore. */
  @Inject(TOKENS.snapshots)
  protected snapshotsService!: SnapshotsService;

  /**
   * Guards restore so it runs at most once and never while a save is mid-flight
   * before the initial load has populated state.
   */
  protected restored: boolean = false;

  /**
   * Serializes every on-disk write (`saveToDisk` / `clearDisk`) so they never
   * race and owns the debounce that collapses rapid saves. scheduleSave, unload,
   * restoreFromDisk's re-save, and the settings-toggle path all hit the same
   * file; the queue keeps them strictly ordered with last-writer-wins semantics.
   */
  protected queue: AsyncSaveQueue = new AsyncSaveQueue(SAVE_DEBOUNCE_MS);

  /**
   * Lazily-created IO collaborator that owns the on-disk shard directory.
   * Resolved through {@link shardStore} so the adapter and resolved shard
   * directory are read once the plugin (and thus its manifest) is ready, never
   * at construction time.
   */
  protected store: HistoryShardStore | null = null;

  /**
   * In-memory map of vault-relative note path to the shard that persists it
   * (filename + content digest). Seeded from disk on restore and maintained by
   * the save path: it is the source of truth for dirty-tracking
   * (skip a shard whose digest is unchanged) and collision-aware naming (probe a
   * suffix when two distinct paths hash to the same filename).
   */
  protected shardIndex: Map<string, ShardIndexEntry> = new Map();

  /**
   * Creates a new instance of PersistenceService.
   *
   * @param {LineChangeTrackerPlugin} plugin - The plugin instance
   */
  public constructor(
    public plugin: LineChangeTrackerPlugin,
  ) {
  }

  /**
   * Loads persisted history once the workspace layout is ready.
   * Deferring to onLayoutReady guarantees the vault file index is populated, so
   * stored paths can be resolved to live files, and it runs after the plugin's
   * own onload wiring without racing the startup file scan.
   */
  public load(): void {
    this.plugin.app.workspace.onLayoutReady((): void => {
      void this.restoreFromDisk();
    });
  }

  /**
   * Flushes any pending history to disk when the plugin unloads.
   * Cancels the debounce timer, enqueues a final save, then awaits the entire
   * write queue so any in-flight or already-queued write has fully completed
   * before the plugin tears down.
   *
   * @return {Promise<void>} Resolves when the queue is drained
   */
  public async unload(): Promise<void> {
    this.queue.cancelScheduled();

    this.enqueueSave();

    await this.writeQueue;
  }

  /**
   * Schedules a debounced save whenever snapshots change.
   * No-op until the initial restore has completed, so the empty pre-restore
   * state cannot overwrite a valid history file on disk.
   */
  @On(PluginEvent.snapshotsUpdate)
  public onSnapshotsUpdate(): void {
    if (!this.restored || !this.isPersistEnabled()) {
      return;
    }

    this.scheduleSave();
  }

  /**
   * Reacts to a settings change that may flip persistence on or off.
   * Disabling persistence removes the on-disk copy so disabled truly means
   * nothing is left behind; enabling it (or changing retention) schedules a
   * save of the current state.
   */
  @On(PluginEvent.settingsUpdate)
  public onSettingsUpdate(): void {
    /**
     * Turning persistence off should drop the on-disk copy so disabled means
     * disabled; turning it on persists the current state right away.
     */
    if (!this.isPersistEnabled()) {
      this.enqueueClear();

      return;
    }

    this.scheduleSave();
  }

  /**
   * Reads, prunes, and restores the persisted history.
   * Respects the persist flag and retention policy, applies the size and age
   * caps before handing entries to the snapshots service, and triggers an
   * editor refresh so restored highlights render immediately.
   *
   * @return {Promise<void>} Resolves when restore finishes
   */
  protected async restoreFromDisk(): Promise<void> {
    try {
      if (!this.isPersistEnabled()) {
        // History is not kept across restarts in this mode; drop any stale file.
        this.enqueueClear();

        return;
      }

      /**
       * One-time monolith-to-shard migration before reading the shard dir. A
       * migration failure leaves the legacy file intact and falls through to a
       * (then-empty) shard read, so no history is lost. The whole legacy concern
       * lives in {@link MonolithMigrator}.
       */
      await new MonolithMigrator(
        this.plugin.app.vault.adapter,
        this.getPluginDir(),
        this.shardStore(),
      ).migrate();

      const loaded: LoadedShard[] = await this.shardStore().readAll();

      /**
       * The shard's serialized snapshot is the read-time identity (the filename
       * is just a path hash). Carry the actual on-disk filename alongside each
       * snapshot so the index can be seeded with the name that is really on
       * disk, including any collision-probed suffix written by a prior save.
       */
      const byPath: Map<SerializedFileSnapshot, string> = new Map();
      const snapshots: SerializedFileSnapshot[] = [];

      for (const item of loaded) {
        byPath.set(item.shard.snapshot, item.name);
        snapshots.push(item.shard.snapshot);
      }

      const kept: SerializedFileSnapshot[] = this.applyRetention(snapshots);

      /**
       * Seed the path-to-shard index from what survived retention: one entry per
       * kept shard, keyed by its path, holding its on-disk filename and a content
       * digest of its serialized snapshot. Over-cap shards are deliberately left
       * out of the index so the re-save below evicts them from disk.
       */
      this.shardIndex.clear();

      for (const snapshot of kept) {
        this.shardIndex.set(snapshot.path, {
          name: byPath.get(snapshot) ?? ShardNameHelper.forPath(snapshot.path),
          digest: this.contentDigest(snapshot),
        });
      }

      this.snapshotsService.restore(kept);

      if (kept.length > 0) {
        this.plugin.forceUpdateEditor();
      }

      // Re-save so the pruned set replaces the over-cap shards on disk.
      if (kept.length !== snapshots.length) {
        this.enqueueSave();
      }
    } finally {
      /**
       * Mark restore complete only now, so a snapshotsUpdate that fires while
       * we are reading the disk cannot trigger a save of the empty pre-restore
       * state and overwrite a valid history file.
       */
      this.restored = true;
    }
  }

  /**
   * Prunes the serialized snapshots to the retained set by binding the current
   * settings caps onto the pure {@link RetentionPolicy}. The two-bucket cap math
   * (live files by count; tombstones by count and age) lives in the policy; this
   * seam only reads the caps the user configured.
   *
   * @param {SerializedFileSnapshot[]} snapshots - The raw persisted snapshots
   * @return {SerializedFileSnapshot[]} The retained subset, newest first
   */
  protected applyRetention(snapshots: SerializedFileSnapshot[]): SerializedFileSnapshot[] {
    const caps: RetentionCaps = {
      maxEntries: this.settingsService.value('retention.maxEntries'),
      maxDeletedEntries: this.settingsService.value('retention.maxDeletedEntries'),
      maxDeletedAgeDays: this.settingsService.value('retention.maxDeletedAgeDays'),
    };

    return RetentionPolicy.apply(snapshots, caps);
  }

  /** Schedules a debounced save, collapsing rapid updates into one. */
  protected scheduleSave(): void {
    this.queue.schedule((): Promise<void> => this.saveToDisk());
  }

  /**
   * Appends a save to the write queue so it runs after every previously
   * scheduled write completes.
   */
  protected enqueueSave(): void {
    this.queue.enqueue((): Promise<void> => this.saveToDisk());
  }

  /** Appends a clear to the write queue so it serializes with pending saves. */
  protected enqueueClear(): void {
    this.queue.enqueue((): Promise<void> => this.clearDisk());
  }

  /**
   * The tail of the serialized write queue. Awaiting it flushes every write
   * submitted so far, so {@link unload} can drain before the plugin tears down.
   *
   * @return {Promise<void>} Resolves when the current write tail completes
   */
  protected get writeQueue(): Promise<void> {
    return this.queue.settled();
  }

  /**
   * Serializes the current snapshots and reconciles them to the shard directory.
   * Applies retention first so the on-disk set stays within caps, then writes
   * only the shards whose content changed (dirty-only) and removes
   * shards for paths that left the kept set. Removes everything when persistence
   * is disabled or nothing is left.
   *
   * Each shard write is atomic at shard granularity inside
   * {@link HistoryShardStore.writeShard}; a crash mid-write loses at most one
   * note's shard and never a truncated file. Blindly rewriting all shards every
   * save would turn one logical change into N atomic `tmp + rename` ops (worse IO
   * than the monolith), so the in-memory index is diffed by content digest and
   * only changed shards are touched.
   *
   * @return {Promise<void>} Resolves when the reconciliation completes
   */
  protected async saveToDisk(): Promise<void> {
    if (!this.isPersistEnabled()) {
      await this.clearDisk();

      return;
    }

    /**
     * Serialization can throw (a single corrupt snapshot's `toJSON`, an encode
     * edge) and retention can throw on unexpected shapes. Both run before the
     * destructive `kept.length === 0` branch, so a failure here must NOT be
     * mistaken for "nothing to keep": that would wipe the entire vault's
     * persisted history over a transient in-memory fault. Catch it, log it, and
     * skip this save so the existing on-disk shards stay intact and the next
     * save retries against a (hopefully) healthy state. Returning here also
     * keeps the throw out of the write queue, which would otherwise reject and
     * permanently starve every later save and the unload flush (the queue's
     * `.then` chain has no rejection handler).
     */
    let payload: SerializedHistory;
    let kept: SerializedFileSnapshot[];

    try {
      payload = this.snapshotsService.serialize();
      kept = this.applyRetention(payload.snapshots);
    } catch (error) {
      console.error('Local history: failed to serialize history; skipping this save to avoid data loss', error);

      return;
    }

    /**
     * The directory-wide wipe may run ONLY for the genuinely-empty case: there
     * is no in-memory history at all (`payload.snapshots` is empty). When live
     * in-memory history exists (`payload.snapshots.length > 0`) we must NEVER
     * nuke the whole shard directory, even if retention kept nothing this pass:
     * doing so would destroy every note's on-disk history in one shot for a
     * vault that still has live history (the idle-vault wipe this change closes).
     * In that case fall through to the per-shard write/removal passes below,
     * which reconcile disk one shard at a time and only remove shards that were
     * actually evicted, renamed, or deleted.
     */
    if (payload.snapshots.length === 0) {
      await this.clearDisk();

      return;
    }

    const store: HistoryShardStore = this.shardStore();
    const keptPaths: Set<string> = new Set();

    /**
     * Write pass: for each kept snapshot, skip when the index already holds the
     * same path with the same digest (unchanged), otherwise resolve or allocate
     * a collision-free shard name, write it, and update the index. The shard's
     * `version` is read through from `serialize()` so the codec's 1->2 bump flows
     * in without a shard-level branch.
     */
    for (const snapshot of kept) {
      keptPaths.add(snapshot.path);

      const digest: string = this.contentDigest(snapshot);
      const existing: ShardIndexEntry | undefined = this.shardIndex.get(snapshot.path);

      if (existing && existing.digest === digest) {
        continue;
      }

      const name: string = existing?.name ?? this.allocateShardName(snapshot.path);

      try {
        await store.writeShard(name, { version: payload.version, snapshot });

        this.shardIndex.set(snapshot.path, { name, digest });
      } catch (error) {
        console.error('Local history: failed to persist history shard', snapshot.path, error);
      }
    }

    /**
     * Removal pass: any indexed path absent from the kept set was evicted by
     * retention, deleted, or re-keyed by a rename/move. Drop its shard from disk
     * and from the index so the index stays consistent with disk.
     */
    for (const [path, entry] of [...this.shardIndex]) {
      if (keptPaths.has(path)) {
        continue;
      }

      await store.removeShard(entry.name);
      this.shardIndex.delete(path);
    }
  }

  /**
   * Allocates a shard filename for a path that has no index entry yet, resolving
   * the astronomically-rare 64-bit hash collision. Binds the live in-memory index
   * as the set of already-claimed names and defers the base-hash-plus-probe
   * allocation to {@link ShardNameHelper.allocate}, so two distinct notes never
   * share a filename and one can never silently overwrite another.
   *
   * @param {string} path - The vault-relative note path to name a shard for
   * @return {string} A shard filename not currently held by any other path
   */
  protected allocateShardName(path: string): string {
    const taken: Set<string> = new Set(
      [...this.shardIndex.values()].map((entry: ShardIndexEntry): string => entry.name),
    );

    return ShardNameHelper.allocate(path, taken);
  }

  /**
   * Wipes the on-disk shard directory and resets the in-memory index.
   * Used when persistence is disabled or there is nothing left to keep, so
   * disabled truly means nothing is left behind. Delegates the directory wipe to
   * {@link HistoryShardStore.clearAll} (which swallows and logs its own IO
   * failures) and then empties {@link shardIndex} so the next save re-allocates
   * shard names from a clean slate rather than reusing stale digests.
   *
   * @return {Promise<void>} Resolves once the directory is gone and the index is empty
   */
  protected async clearDisk(): Promise<void> {
    await this.shardStore().clearAll();
    this.shardIndex.clear();
  }

  /**
   * Resolves the vault-relative path of the per-note shard directory inside the
   * plugin folder, pointing at `<plugindir>/history` (ADR-10).
   *
   * @return {string} The vault-relative path to the shard directory
   */
  protected getShardDir(): string {
    return `${this.getPluginDir()}/${HISTORY_SHARD_DIR}`;
  }

  /**
   * Resolves the plugin's own folder, falling back to a sane default if the
   * manifest dir is missing. Shared by {@link getShardDir} (shard directory) and
   * {@link MonolithMigrator} (which derives the legacy monolith path from it) so
   * both resolve identically.
   *
   * @return {string} The vault-relative plugin directory
   */
  protected getPluginDir(): string {
    return this.plugin.manifest.dir
      ?? `${this.plugin.app.vault.configDir}/plugins/${this.plugin.manifest.id}`;
  }

  /**
   * Returns the shard store, creating it once on first use. Construction is
   * deferred so the adapter and resolved shard directory are read after the
   * plugin manifest is available, not at service construction time.
   *
   * @return {HistoryShardStore} The shared shard store instance
   */
  protected shardStore(): HistoryShardStore {
    if (!this.store) {
      this.store = new HistoryShardStore(this.plugin.app.vault.adapter, this.getShardDir());
    }

    return this.store;
  }

  /**
   * Computes a >=64-bit content digest of a serialized snapshot, used to detect
   * whether a shard's content actually changed between saves. Reuses the shared
   * {@link ShardNameHelper} hash (not the 32-bit `TextHelper.hash`, which is too
   * narrow and load-bearing for change detection elsewhere) over the snapshot's
   * JSON, so an unchanged snapshot yields a stable digest and a changed one a
   * different digest with astronomically-rare collisions.
   *
   * @param {SerializedFileSnapshot} snapshot - The serialized snapshot to digest
   * @return {string} A deterministic content digest string
   */
  protected contentDigest(snapshot: SerializedFileSnapshot): string {
    return ShardNameHelper.forPath(JSON.stringify(snapshot));
  }

  /**
   * Whether history should be persisted to disk right now.
   * Requires the explicit persist toggle and a retention policy that keeps
   * history beyond a single file close (file-scoped history is never persisted
   * since it is meant to vanish when the file is closed).
   *
   * @return {boolean} True when persistence is active
   */
  protected isPersistEnabled(): boolean {
    return this.settingsService.value('persist')
      && this.settingsService.value('keep') === KeepHistory.app;
  }
}
