import { ObsidianEvent } from '@/consts';
import { Inject } from '@/decorators/inject.decorator';
import { BaseEvent } from '@/events/base.event';
import type { SettingsService } from '@/services/settings.service';
import type { SnapshotsService } from '@/services/snapshots.service';
import type { ObsidianEventName } from '@/types';
import { type TAbstractFile, TFile } from 'obsidian';

/**
 * Event handler for Obsidian's vault create event.
 * Manages the ignore list when new files are created in the vault.
 * If the "ignore new files" setting is enabled, adds newly created files
 * to the ignore list to prevent tracking changes in them.
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
   * Handles the vault create event by managing the ignore list for new files.
   * If the "ignore new files" setting is enabled and the file has an allowed extension,
   * adds the file to the ignore list to prevent change tracking.
   *
   * @param {TAbstractFile} file - The file that was created in the vault
   */
  public handler(file: TAbstractFile): void {
    if (!(file instanceof TFile)) {
      return;
    }

    // If ignoring new files is enabled, add a file to ignore list
    if (this.settingsService.value('ignoreNewFiles') && this.snapshotsService.isInAllowedExtensions(file)) {
      this.snapshotsService.addToIgnoreList(file);
    }
  }
}
