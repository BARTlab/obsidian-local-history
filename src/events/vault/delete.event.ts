import { ObsidianEvent } from '@/consts';
import { Inject } from '@/decorators/inject.decorator';
import { BaseEvent } from '@/events/base.event';
import type { SnapshotsService } from '@/services/snapshots.service';
import type { ObsidianEventName } from '@/types';
import { type TAbstractFile, TFile } from 'obsidian';

/**
 * Event handler for Obsidian's vault delete event.
 * Drops the file snapshot and its ignore-list entry when a tracked file is
 * deleted so stale state is not leaked for a file that no longer exists.
 *
 * @extends {BaseEvent}
 */
export class VaultDeleteEvent extends BaseEvent {
  /**
   * Service for managing file snapshots.
   * Injected using the @Inject decorator.
   */
  @Inject('SnapshotsService')
  protected snapshotsService: SnapshotsService;

  /**
   * The name of the Obsidian event to handle.
   * Set to the vault.delete event.
   */
  public readonly name: ObsidianEventName = ObsidianEvent.vault.delete;

  /**
   * Handles the vault delete event by removing the snapshot and ignore entry.
   * Skips non-file entries (folders).
   *
   * @param {TAbstractFile} file - The file that was deleted from the vault
   */
  public handler(file: TAbstractFile): void {
    if (!(file instanceof TFile)) {
      return;
    }

    this.snapshotsService.remove(file);
    this.snapshotsService.removeFromIgnoreList(file);
  }
}
