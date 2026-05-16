import { KeepHistory, PluginEvent } from '@/consts';
import { Inject } from '@/decorators/inject.decorator';
import { On } from '@/decorators/on.decorator';
import type LineChangeTrackerPlugin from '@/main';
import type { SettingsService } from '@/services/settings.service';
import type { SnapshotsService } from '@/services/snapshots.service';
import type { SerializedFileSnapshot, SerializedHistory, Service } from '@/types';

/**
 * Number of milliseconds in a day, used to translate the age cap (in days)
 * from settings into a timestamp comparison.
 */
const MS_PER_DAY: number = 24 * 60 * 60 * 1000;

/**
 * Debounce window (ms) for disk writes so a burst of snapshot updates collapses
 * into a single save instead of writing on every keystroke-driven change.
 */
const SAVE_DEBOUNCE_MS: number = 1500;

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
   * Cancels the debounce timer and performs a final synchronous-style save so
   * the latest state is not lost on disable or app quit.
   *
   * @return {Promise<void>} Resolves when the final save completes
   */
  public async unload(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }

    await this.saveToDisk();
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
    // Turning persistence off should drop the on-disk copy so disabled means
    // disabled; turning it on persists the current state right away.
    if (!this.isPersistEnabled()) {
      void this.clearDisk();

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
        await this.clearDisk();

        return;
      }

      const history: SerializedHistory | null = await this.readDisk();

      if (!history) {
        return;
      }

      const kept: SerializedFileSnapshot[] = this.applyRetention(history.snapshots);

      this.snapshotsService.restore(kept);

      if (kept.length > 0) {
        this.plugin.forceUpdateEditor();
      }

      // Re-save so the pruned set replaces an over-cap file on disk.
      if (kept.length !== history.snapshots.length) {
        await this.saveToDisk();
      }
    } finally {
      // Mark restore complete only now, so a snapshotsUpdate that fires while
      // we are reading the disk cannot trigger a save of the empty pre-restore
      // state and overwrite a valid history file.
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

      if (typeof item.deletedTimestamp === 'number') {
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
      // Age a tombstone by its deletion time so the policy answers "how long do
      // we keep deleted-file recoverability" rather than "how stale was the file
      // when it was deleted".
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

    // Newest first so the size cap evicts the stalest entries.
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
      void this.saveToDisk();
    }, SAVE_DEBOUNCE_MS);
  }

  /**
   * Serializes the current snapshots and writes them to the history file.
   * Applies retention before writing so the on-disk set stays within caps, and
   * removes the file entirely when persistence is disabled or nothing is left.
   *
   * @return {Promise<void>} Resolves when the write completes
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

    try {
      await this.plugin.app.vault.adapter.write(
        this.getHistoryPath(),
        JSON.stringify({ version: payload.version, snapshots: kept }),
      );
    } catch (error) {
      console.error('Local history: failed to persist history', error);
    }
  }

  /**
   * Reads and parses the on-disk history file.
   * Returns null when the file is absent or unreadable so callers can treat a
   * missing or corrupt store as "no history" rather than throwing.
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

      return parsed;
    } catch (error) {
      console.error('Local history: failed to read persisted history', error);

      return null;
    }
  }

  /**
   * Removes the on-disk history file if it exists.
   * Used when persistence is disabled or there is nothing left to keep.
   *
   * @return {Promise<void>} Resolves when the file is removed (or was absent)
   */
  protected async clearDisk(): Promise<void> {
    const path: string = this.getHistoryPath();

    try {
      if (await this.plugin.app.vault.adapter.exists(path)) {
        await this.plugin.app.vault.adapter.remove(path);
      }
    } catch (error) {
      console.error('Local history: failed to clear persisted history', error);
    }
  }

  /**
   * Resolves the absolute (vault-relative) path of the history file inside the
   * plugin folder. Falls back to a sane default if the manifest dir is missing.
   *
   * @return {string} The vault-relative path to the history file
   */
  protected getHistoryPath(): string {
    const dir: string = this.plugin.manifest.dir
      ?? `${this.plugin.app.vault.configDir}/plugins/${this.plugin.manifest.id}`;

    return `${dir}/history.json`;
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
