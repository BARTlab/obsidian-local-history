import { ObsidianEvent } from '@/consts';
import { Inject } from '@/decorators/inject.decorator';
import { BaseEvent } from '@/events/base.event';
import type { SettingsService } from '@/services/settings.service';
import type { SnapshotsService } from '@/services/snapshots.service';
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
  @Inject('SettingsService')
  protected settingsService: SettingsService;

  /**
   * Service for managing file snapshots and ignore a list.
   * Injected using the @Inject decorator.
   */
  @Inject('SnapshotsService')
  protected snapshotsService: SnapshotsService;

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
   * @param {TAbstractFile} file - The file that was created in the vault
   */
  public handler(file: TAbstractFile): void {
    if (!(file instanceof TFile)) {
      return;
    }

    if (this.settingsService.value('ignoreNewFiles')) {
      if (this.snapshotsService.isInAllowedExtensions(file)) {
        this.snapshotsService.addToIgnoreList(file);
      }

      return;
    }

    void this.snapshotsService.capture(file);
  }
}
