import { ObsidianEvent } from '@/consts';
import { Inject } from '@/decorators/inject.decorator';
import { BaseEvent } from '@/events/base.event';
import type { SettingsService } from '@/services/settings.service';
import type { SnapshotsService } from '@/services/snapshots.service';
import { TOKENS } from '@/services/tokens';
import type { FileSnapshot } from '@/snapshots/file.snapshot';
import type { ObsidianEventName } from '@/types';
import { type TAbstractFile, TFile } from 'obsidian';

/**
 * Event handler for Obsidian's vault create event.
 *
 * Two behaviours, keyed on the "ignore new files" setting:
 * - When enabled, a newly created file with an allowed extension is added to
 *   the ignore list so its changes are never tracked.
 * - When disabled, the file is captured into a baseline snapshot right away.
 *   Without this eager capture a created or copied file has no snapshot until
 *   it is later opened or written to, so folder-history (which is built purely
 *   from the snapshot map) cannot surface it as an added file until some
 *   unrelated event happens to capture it.
 *
 * @extends {BaseEvent}
 */
export class VaultCreateEvent extends BaseEvent {
  /**
   * Service for accessing plugin settings.
   * Injected using the @Inject decorator.
   */
  @Inject(TOKENS.settings)
  protected settingsService!: SettingsService;

  /**
   * Service for managing file snapshots and ignore a list.
   * Injected using the @Inject decorator.
   */
  @Inject(TOKENS.snapshots)
  protected snapshotsService!: SnapshotsService;

  /**
   * The name of the Obsidian event to handle.
   * Set to the vault.create event.
   */
  public name: ObsidianEventName = ObsidianEvent.vault.create;

  /**
   * Handles the vault create event. When the "ignore new files" setting is on,
   * a new file with an allowed extension is added to the ignore list so it is
   * never tracked. Otherwise the file is captured into a baseline snapshot at
   * once, so a created or copied file is tracked from the moment it appears and
   * shows up in folder history (which is derived purely from the snapshot map)
   * without waiting for a later open or write to capture it.
   *
   * `capture` applies its own extension / excluded-path / already-captured /
   * ignore-list gating, so it is safe to call unconditionally here.
   *
   * Because vault events are registered only after `workspace.onLayoutReady`
   * (the cold-start create burst for pre-existing files is excluded), every
   * create reaching this handler is a genuine user action this run, so the
   * captured snapshot is stamped with the transient `createdThisSession` flag
   * so the tree/tab decorator can paint it green. The capture is
   * awaited before stamping because it builds the snapshot asynchronously.
   *
   * @param {TAbstractFile} file - The file that was created in the vault
   * @return {Promise<void>} Resolves once the create has been handled
   */
  public async handler(file: TAbstractFile): Promise<void> {
    if (!(file instanceof TFile)) {
      return;
    }

    /**
     * Record the created path for the tree/tab decorator BEFORE the ignore-list
     * branch. A file created this session reads as "added" in the tree
     * even when "ignore new files" is on and therefore no snapshot exists to
     * carry `createdThisSession`; the decorator paints it from this path set.
     */
    this.snapshotsService.markCreatedThisSession(file.path);

    if (this.settingsService.value('ignoreNewFiles')) {
      if (this.snapshotsService.isInAllowedExtensions(file)) {
        this.snapshotsService.addToIgnoreList(file);
      }

      return;
    }

    await this.snapshotsService.capture(file);

    const snapshot: FileSnapshot | null = this.snapshotsService.getOne(file);

    if (snapshot) {
      snapshot.createdThisSession = true;
    }
  }
}
