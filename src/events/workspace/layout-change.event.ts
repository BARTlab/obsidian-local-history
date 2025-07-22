import { KeepHistory, ObsidianEvent } from '@/consts';
import { Inject } from '@/decorators/inject.decorator';
import { BaseEvent } from '@/events/base.event';
import type { SettingsService } from '@/services/settings.service';
import type { SnapshotsService } from '@/services/snapshots.service';
import type { FileSnapshot } from '@/snapshots/file.snapshot';
import type { ObsidianEventName } from '@/types';
import type { TFile } from 'obsidian';

/**
 * Event handler for Obsidian's layout change event.
 * Manages snapshots when the workspace layout changes (files opened/closed).
 * Removes snapshots for closed files and creates snapshots for newly opened files.
 *
 * @extends {BaseEvent}
 */
export class WorkspaceLayoutChangeEvent extends BaseEvent {
  /**
   * Service for managing file snapshots.
   * Injected using the @Inject decorator.
   */
  @Inject('SnapshotsService')
  protected snapshotsService: SnapshotsService;

  /**
   * Service for accessing plugin settings.
   * Injected using the @Inject decorator.
   */
  @Inject('SettingsService')
  protected settingsService: SettingsService;

  /**
   * The name of the Obsidian event to handle.
   * Set to the workspace.layoutChange event.
   */
  public name: ObsidianEventName = ObsidianEvent.workspace.layoutChange;

  /**
   * Handles the layout change event by managing snapshots.
   * Performs two main tasks:
   * 1. Removes snapshots for files that have been closed (if configured to not keep history)
   * 2. Creates snapshots for newly opened files that don't have snapshots yet
   */
  public handler(): void {
    const openedFiles: Set<TFile> = this.plugin.getWorkspaceFiles();

    // Looking for files that were closed, but they are still in the state
    this.snapshotsService.getList().forEach((snapshot: FileSnapshot): void => {
      if (!snapshot.file || !this.isOnFileClose()) {
        return;
      }

      if (!openedFiles.has(snapshot.file)) {
        this.snapshotsService.wipeOne(snapshot.file);
      }
    });

    // Remove a file from an ignored list
    this.snapshotsService.getIgnoreList().forEach((file: TFile): void => {
      if (!openedFiles.has(file)) {
        this.snapshotsService.removeFromIgnoreList(file)
      }
    });

    // Looking for new files that are not in the state
    openedFiles.forEach((file: TFile): void => {
      // Most likely an unnecessary check
      if (!this.snapshotsService.getOne(file)) {
        void this.snapshotsService.capture(file);
      }
    });
  };

  /**
   * Checks if the plugin is configured to remove snapshots when files are closed.
   *
   * @return {boolean} True if the keep history setting is set to 'file', false otherwise
   */
  protected isOnFileClose(): boolean {
    return this.settingsService.value('keep') === KeepHistory.file;
  }
}
