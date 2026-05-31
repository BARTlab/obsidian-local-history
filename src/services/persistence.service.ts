import { isNumber, isString } from 'lodash-es';

import { HISTORY_SHARD_DIR, KeepHistory, MS_PER_DAY, PluginEvent, SAVE_DEBOUNCE_MS } from '@/consts';
import { Inject } from '@/decorators/inject.decorator';
import { On } from '@/decorators/on.decorator';
import { ShardNameHelper } from '@/helpers/shard-name.helper';
import type LineChangeTrackerPlugin from '@/main';
import { HistoryShardStore, type LoadedShard } from '@/persistence/history-shard-store';
import type { SettingsService } from '@/services/settings.service';
import type { SnapshotsService } from '@/services/snapshots.service';
import type { SerializedFileSnapshot, SerializedHistory, Service } from '@/types';

/**
 * One in-memory index entry for a persisted shard: the on-disk filename to write
 * or remove it under, and a >=64-bit content digest of its serialized snapshot.
 * The save path (Epic 10, T07) diffs the live digest against this to write only
 * changed shards, and reuses `name` for collision-aware naming so two distinct
 * notes never share a filename.
 */
export interface ShardIndexEntry {
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
  /**
   * Service for accessing plugin settings (persist flag and retention caps).
   * Injected using the @Inject decorator.
   */
  @Inject('SettingsService')
  protected settingsService: SettingsService;

  /**
   * Service holding the in-memory snapshots to serialize and restore.
   * Injected using the @Inject decorator.
   */
  @Inject('SnapshotsService')
  protected snapshotsService: SnapshotsService;

  /**
   * Pending debounced save timer handle, or null when no save is scheduled.
   */
  protected saveTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Guards restore so it runs at most once and never while a save is mid-flight
   * before the initial load has populated state.
   */
  protected restored: boolean = false;

  /**
   * Promise chain that serializes all on-disk writes (`saveToDisk` /
   * `clearDisk`). Every public entry point appends its work as `.then(...)`,
   * so writes run strictly in submission order and `unload` can await the
   * tail to flush the queue before the plugin tears down.
   *
   * ADR-08-A: scheduleSave, unload, restoreFromDisk's re-save, and the
   * settings-toggle path all hit the same file; without one chain they race
   * `adapter.write` and last-writer-wins is non-deterministic.
   */
  protected writeQueue: Promise<void> = Promise.resolve();

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
   * the save path (Epic 10, T07): it is the source of truth for dirty-tracking
   * (skip a shard whose digest is unchanged) and collision-aware naming (probe a
   * suffix when two distinct paths hash to the same filename).
   */
  protected shardIndex: Map<string, ShardIndexEntry> = new Map<string, ShardIndexEntry>();

  /**
   * Creates a new instance of PersistenceService.
   *
   * @param {LineChangeTrackerPlugin} plugin - The plugin instance
   */
  public constructor(
    protected plugin: LineChangeTrackerPlugin,
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
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }

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
        /**
         * History is not kept across restarts in this mode; drop any stale file.
         */
        this.enqueueClear();

        return;
      }

      const loaded: LoadedShard[] = await this.shardStore().readAll();

      /**
       * The shard's serialized snapshot is the read-time identity (the filename
       * is just a path hash). Carry the actual on-disk filename alongside each
       * snapshot so the index can be seeded with the name that is really on
       * disk, including any collision-probed suffix written by a prior save.
       */
      const byPath: Map<SerializedFileSnapshot, string> = new Map<SerializedFileSnapshot, string>();
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
       * out of the index so the re-save below evicts them from disk (T07).
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

      /**
       * Re-save so the pruned set replaces the over-cap shards on disk.
       */
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
   * Applies the size and age caps to a list of serialized snapshots.
   * Runs two independent passes (D4): live snapshots are bounded by
   * `retention.maxEntries` / `retention.maxAgeDays` and tombstones
   * (entries with `deletedTimestamp` set) by
   * `retention.maxDeletedEntries` / `retention.maxDeletedAgeDays`.
   * A cap of 0 disables that dimension for its bucket, matching the live caps.
   *
   * @param {SerializedFileSnapshot[]} snapshots - The raw persisted snapshots
   * @return {SerializedFileSnapshot[]} The retained subset, newest first
   */
  protected applyRetention(snapshots: SerializedFileSnapshot[]): SerializedFileSnapshot[] {
    if (!Array.isArray(snapshots)) {
      return [];
    }

    const live: SerializedFileSnapshot[] = [];
    const tombstones: SerializedFileSnapshot[] = [];

    for (const item of snapshots) {
      if (!item) {
        continue;
      }

      if (isNumber(item.deletedTimestamp)) {
        tombstones.push(item);
      } else {
        live.push(item);
      }
    }

    const keptLive: SerializedFileSnapshot[] = this.applyBucketRetention(
      live,
      this.settingsService.value('retention.maxEntries'),
      this.settingsService.value('retention.maxAgeDays'),
      (item: SerializedFileSnapshot): number => item.timestamp,
    );

    const keptTombstones: SerializedFileSnapshot[] = this.applyBucketRetention(
      tombstones,
      this.settingsService.value('retention.maxDeletedEntries'),
      this.settingsService.value('retention.maxDeletedAgeDays'),
      /**
       * Age a tombstone by its deletion time so the policy answers "how long do
       * we keep deleted-file recoverability" rather than "how stale was the file
       * when it was deleted".
       */
      (item: SerializedFileSnapshot): number => item.deletedTimestamp ?? item.timestamp,
    );

    return [...keptLive, ...keptTombstones];
  }

  /**
   * Runs a single retention pass on a bucket of serialized snapshots, dropping
   * entries older than `maxAgeDays` (when > 0) and then capping by
   * `maxEntries` (when > 0). The bucket's "age" is read through the supplied
   * accessor so live snapshots can age by `timestamp` and tombstones by
   * `deletedTimestamp`.
   *
   * @param {SerializedFileSnapshot[]} bucket - The bucket to prune (not mutated)
   * @param {number} maxEntries - Size cap for this bucket (0 disables)
   * @param {number} maxAgeDays - Age cap in days for this bucket (0 disables)
   * @param {(item: SerializedFileSnapshot) => number} ageOf - Reads the age timestamp from an item
   * @return {SerializedFileSnapshot[]} The retained subset, newest first
   */
  protected applyBucketRetention(
    bucket: SerializedFileSnapshot[],
    maxEntries: number,
    maxAgeDays: number,
    ageOf: (item: SerializedFileSnapshot) => number,
  ): SerializedFileSnapshot[] {
    const oldest: number = maxAgeDays > 0 ? Date.now() - (maxAgeDays * MS_PER_DAY) : 0;

    let kept: SerializedFileSnapshot[] = bucket.filter((item: SerializedFileSnapshot): boolean =>
      oldest === 0 || ageOf(item) >= oldest
    );

    /**
     * Newest first so the size cap evicts the stalest entries.
     */
    kept.sort((a: SerializedFileSnapshot, b: SerializedFileSnapshot): number => ageOf(b) - ageOf(a));

    if (maxEntries > 0 && kept.length > maxEntries) {
      kept = kept.slice(0, maxEntries);
    }

    return kept;
  }

  /**
   * Schedules a debounced write to disk, collapsing rapid updates into one.
   */
  protected scheduleSave(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }

    this.saveTimer = setTimeout((): void => {
      this.saveTimer = null;
      this.enqueueSave();
    }, SAVE_DEBOUNCE_MS);
  }

  /**
   * Appends a save to the write queue so it runs after every previously
   * scheduled write completes. The queue swallows individual write failures
   * (logged inside `saveToDisk`) so a single bad write does not poison the
   * chain and starve later writes.
   */
  protected enqueueSave(): void {
    this.writeQueue = this.writeQueue.then((): Promise<void> => this.saveToDisk());
  }

  /**
   * Appends a clear to the write queue so it serializes with pending saves.
   */
  protected enqueueClear(): void {
    this.writeQueue = this.writeQueue.then((): Promise<void> => this.clearDisk());
  }

  /**
   * Serializes the current snapshots and reconciles them to the shard directory.
   * Applies retention first so the on-disk set stays within caps, then writes
   * only the shards whose content changed (dirty-only, Epic 10 T07) and removes
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

    const payload: SerializedHistory = this.snapshotsService.serialize();
    const kept: SerializedFileSnapshot[] = this.applyRetention(payload.snapshots);

    if (kept.length === 0) {
      await this.clearDisk();

      return;
    }

    const store: HistoryShardStore = this.shardStore();
    const keptPaths: Set<string> = new Set<string>();

    /**
     * Write pass: for each kept snapshot, skip when the index already holds the
     * same path with the same digest (unchanged), otherwise resolve or allocate
     * a collision-free shard name, write it, and update the index. The shard's
     * `version` is read through from `serialize()` so Epic 09's 1->2 bump flows
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
   * the astronomically-rare 64-bit hash collision. The base name is the path
   * hash; if a different path already holds it in the index, a numeric suffix is
   * linear-probed until free so two distinct notes never share a filename and one
   * can never silently overwrite another (Epic 10 DECISIONS).
   *
   * @param {string} path - The vault-relative note path to name a shard for
   * @return {string} A shard filename not currently held by any other path
   */
  protected allocateShardName(path: string): string {
    const base: string = ShardNameHelper.forPath(path);
    const taken: Set<string> = new Set<string>(
      [...this.shardIndex.values()].map((entry: ShardIndexEntry): string => entry.name),
    );

    if (!taken.has(base)) {
      return base;
    }

    /**
     * Probe `<hash>.json`, `<hash>-1.json`, `<hash>-2.json`, ... by splitting the
     * base into its hash and extension so the suffix lands before `.json` and the
     * file keeps a recognizable shard extension.
     */
    const dot: number = base.lastIndexOf('.');
    const stem: string = dot === -1 ? base : base.slice(0, dot);
    const ext: string = dot === -1 ? '' : base.slice(dot);

    let suffix: number = 1;
    let candidate: string = `${stem}-${suffix}${ext}`;

    while (taken.has(candidate)) {
      suffix += 1;
      candidate = `${stem}-${suffix}${ext}`;
    }

    return candidate;
  }

  /**
   * Reads and parses the on-disk history file.
   * Returns null when the file is absent or unreadable so callers can treat a
   * missing or corrupt store as "no history" rather than throwing.
   *
   * Per-entry validation (ADR-08-B): each snapshot is checked against a minimal
   * shape predicate (`isValidEntry`) and malformed entries are skipped so a few
   * bad records do not poison retention math (`NaN >= oldest` is always false,
   * silently dropping otherwise-valid entries) or crash downstream `fromJSON`.
   *
   * @return {Promise<SerializedHistory | null>} The parsed history, or null
   */
  protected async readDisk(): Promise<SerializedHistory | null> {
    const path: string = this.getHistoryPath();

    try {
      if (!(await this.plugin.app.vault.adapter.exists(path))) {
        return null;
      }

      const raw: string = await this.plugin.app.vault.adapter.read(path);
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
   * survive retention math and reach `FileSnapshot.fromJSON` without falling
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

    if (!isString(item.path)) {
      return false;
    }

    if (!isNumber(item.timestamp) || !Number.isFinite(item.timestamp)) {
      return false;
    }

    if (!Array.isArray(item.lines) || !Array.isArray(item.tracker)) {
      return false;
    }

    return true;
  }

  /**
   * Wipes the on-disk shard directory and resets the in-memory index.
   * Used when persistence is disabled or there is nothing left to keep, so
   * disabled truly means nothing is left behind. Delegates the directory wipe to
   * {@link HistoryShardStore.clearAll} (which swallows and logs its own IO
   * failures) and then empties {@link shardIndex} so the next save re-allocates
   * shard names from a clean slate rather than reusing stale digests (Epic 10,
   * T08).
   *
   * @return {Promise<void>} Resolves once the directory is gone and the index is empty
   */
  protected async clearDisk(): Promise<void> {
    await this.shardStore().clearAll();
    this.shardIndex.clear();
  }

  /**
   * Resolves the absolute (vault-relative) path of the history file inside the
   * plugin folder. Falls back to a sane default if the manifest dir is missing.
   *
   * @return {string} The vault-relative path to the history file
   */
  protected getHistoryPath(): string {
    return `${this.getPluginDir()}/history.json`;
  }

  /**
   * Resolves the vault-relative path of the per-note shard directory inside the
   * plugin folder. Resolved the same way as {@link getHistoryPath} but pointing
   * at `<plugindir>/history` (Epic 10, ADR-10).
   *
   * @return {string} The vault-relative path to the shard directory
   */
  protected getShardDir(): string {
    return `${this.getPluginDir()}/${HISTORY_SHARD_DIR}`;
  }

  /**
   * Resolves the plugin's own folder, falling back to a sane default if the
   * manifest dir is missing. Shared by {@link getHistoryPath} (legacy monolith)
   * and {@link getShardDir} (shard directory) so both resolve identically.
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
