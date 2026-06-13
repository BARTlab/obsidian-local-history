import { ObsidianEvent } from '@/consts';
import { Inject } from '@/decorators/inject.decorator';
import { BaseEvent } from '@/events/base.event';
import { PathHelper } from '@/helpers/path.helper';
import type { SnapshotsService } from '@/services/snapshots.service';
import { TOKENS } from '@/services/tokens';
import type { ObsidianEventName } from '@/types';
import { type TAbstractFile, TFile } from 'obsidian';

/**
 * Event handler for Obsidian's vault rename event.
 * Branches by whether the rename changed the file's directory (epic 05 D2/D3):
 * - in-place rename (same directory) is a pure re-key via `rename`.
 * - cross-directory rename (move) leaves a tombstone at the old path and
 *   re-keys the live snapshot to the new path via `markMoved`.
 *
 * @extends {BaseEvent}
 */
export class VaultRenameEvent extends BaseEvent {
  /**
   * Service for managing file snapshots.
   * Injected using the @Inject decorator.
   */
  @Inject(TOKENS.snapshots)
  protected snapshotsService: SnapshotsService;

  /**
   * The name of the Obsidian event to handle.
   * Set to the vault.rename event.
   */
  public readonly name: ObsidianEventName = ObsidianEvent.vault.rename;

  /**
   * Handles the vault rename event. Routes to `markMoved` when the directory
   * changed (move) and to `rename` when it did not (in-place rename). Skips
   * non-file entries (folders).
   *
   * @param {TAbstractFile} file - The file in its renamed state (new path)
   * @param {string} oldPath - The path the file had before the rename
   */
  public handler(file: TAbstractFile, oldPath: string): void {
    if (!(file instanceof TFile)) {
      return;
    }

    if (PathHelper.dirname(oldPath) === PathHelper.dirname(file.path)) {
      this.snapshotsService.rename(oldPath, file);

      return;
    }

    this.snapshotsService.markMoved(oldPath, file);
  }
}
