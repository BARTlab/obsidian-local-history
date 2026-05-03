import { ObsidianEvent } from '@/consts';
import { Inject } from '@/decorators/inject.decorator';
import { BaseEvent } from '@/events/base.event';
import type { SnapshotsService } from '@/services/snapshots.service';
import type { ObsidianEventName } from '@/types';
import { type TAbstractFile, TFile } from 'obsidian';

/**
 * Event handler for Obsidian's vault rename event.
 * Re-keys the file snapshot when a tracked file is renamed or moved so the
 * existing history follows the file to its new path instead of being lost.
 *
 * @extends {BaseEvent}
 */
export class VaultRenameEvent extends BaseEvent {
  /**
   * Service for managing file snapshots.
   * Injected using the @Inject decorator.
   */
  @Inject('SnapshotsService')
  protected snapshotsService: SnapshotsService;

  /**
   * The name of the Obsidian event to handle.
   * Set to the vault.rename event.
   */
  public readonly name: ObsidianEventName = ObsidianEvent.vault.rename;

  /**
   * Handles the vault rename event by moving the snapshot to the new path.
   * Skips non-file entries (folders).
   *
   * @param {TAbstractFile} file - The file in its renamed state (new path)
   * @param {string} oldPath - The path the file had before the rename
   */
  public handler(file: TAbstractFile, oldPath: string): void {
    if (!(file instanceof TFile)) {
      return;
    }

    this.snapshotsService.rename(oldPath, file);
  }
}
