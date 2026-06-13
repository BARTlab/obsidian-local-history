import { ObsidianEvent } from '@/consts';
import { Inject } from '@/decorators/inject.decorator';
import { BaseEvent } from '@/events/base.event';
import type { SnapshotsService } from '@/services/snapshots.service';
import { TOKENS } from '@/services/tokens';
import type { ObsidianEventName } from '@/types';
import { type TAbstractFile, TFile } from 'obsidian';

/**
 * Event handler for Obsidian's vault delete event.
 * Turns the live snapshot into a tombstone via `SnapshotsService.markDeleted`
 * so the file's history survives the delete (epic 05 D1) and still drops the
 * ignore-list entry so stale gating state is not leaked.
 *
 * @extends {BaseEvent}
 */
export class VaultDeleteEvent extends BaseEvent {
  /**
   * Service for managing file snapshots.
   * Injected using the @Inject decorator.
   */
  @Inject(TOKENS.snapshots)
  protected snapshotsService: SnapshotsService;

  /**
   * The name of the Obsidian event to handle.
   * Set to the vault.delete event.
   */
  public readonly name: ObsidianEventName = ObsidianEvent.vault.delete;

  /**
   * Handles the vault delete event by tombstoning the snapshot and dropping
   * the ignore entry. Skips non-file entries (folders).
   *
   * @param {TAbstractFile} file - The file that was deleted from the vault
   */
  public handler(file: TAbstractFile): void {
    if (!(file instanceof TFile)) {
      return;
    }

    this.snapshotsService.markDeleted(file);
    this.snapshotsService.removeFromIgnoreList(file);
  }
}
