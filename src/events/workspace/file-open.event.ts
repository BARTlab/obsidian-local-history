import { ObsidianEvent } from '@/consts';
import { Inject } from '@/decorators/inject.decorator';
import { BaseEvent } from '@/events/base.event';
import type { SnapshotsService } from '@/services/snapshots.service';
import type { ObsidianEventName } from '@/types';
import type { TFile } from 'obsidian';

/**
 * Event handler for Obsidian's file open event.
 * Creates a snapshot of a file when it's opened in the editor.
 * Ensures the plugin has a baseline version of the file to track changes against.
 *
 * @extends {BaseEvent}
 */
export class WorkspaceFileOpenEvent extends BaseEvent {
  /**
   * Service for managing file snapshots.
   * Injected using the @Inject decorator.
   */
  @Inject('SnapshotsService')
  protected snapshotsService: SnapshotsService;

  /**
   * The name of the Obsidian event to handle.
   * Set to the workspace.fileOpen event.
   */
  public name: ObsidianEventName = ObsidianEvent.workspace.fileOpen;

  /**
   * Handles the file open event by capturing a snapshot of the file.
   * Skips processing if no file is provided (null check).
   *
   * @param {TFile | null} file - The file that was opened or null if no file
   */
  public handler(file: TFile | null): void {
    if (!file) {
      return;
    }

    void this.snapshotsService.capture(file);
  };
}
