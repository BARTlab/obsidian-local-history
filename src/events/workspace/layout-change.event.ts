import { KeepHistory, ObsidianEvent } from '@/consts';
import { Inject } from '@/decorators/inject.decorator';
import { BaseEvent } from '@/events/base.event';
import type { SettingsService } from '@/services/settings.service';
import type { SnapshotsService } from '@/services/snapshots.service';
import { TOKENS } from '@/services/tokens';
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
   * The name of the Obsidian event to handle.
   * Set to the workspace.layoutChange event.
   */
  public name: ObsidianEventName = ObsidianEvent.workspace.layoutChange;

  @Inject(TOKENS.snapshots)
  protected snapshotsService!: SnapshotsService;

  @Inject(TOKENS.settings)
  protected settingsService!: SettingsService;

  /**
   * Handles the layout change event by managing snapshots.
   * Performs two main tasks:
   * 1. Removes snapshots for files that have been closed (if configured to not keep history)
   * 2. Creates snapshots for newly opened files that don't have snapshots yet
   */
  public handler(): void {
    const openedFiles: Set<TFile> = this.plugin.getWorkspaceFiles();

    /**
     * Snapshot every collection into a local array before iteration so the
     * mutating service calls below (wipeOne, ignoreList.remove) and the
     * follow-up captures cannot re-enter the loops they are walking
     *.
     */
    const snapshots: FileSnapshot[] = this.snapshotsService.getList();
    const ignored: TFile[] = this.snapshotsService.ignoreList.list();
    const opened: TFile[] = [...openedFiles];

    const closedSnapshots: TFile[] = [];
    const closedIgnored: TFile[] = [];
    const newlyOpened: TFile[] = [];

    /**
     * Pass 1: collect snapshots whose file is no longer open (when history is
     * not kept after a file is closed). No service mutation here.
     */
    const dropOnClose: boolean = this.isOnFileClose();

    for (const snapshot of snapshots) {
      if (!snapshot.file || !dropOnClose) {
        continue;
      }

      if (!openedFiles.has(snapshot.file)) {
        closedSnapshots.push(snapshot.file);
      }
    }

    // Pass 2: collect ignore-list entries whose file is no longer open.
    for (const file of ignored) {
      if (!openedFiles.has(file)) {
        closedIgnored.push(file);
      }
    }

    // Pass 3: collect newly opened files that are not yet tracked.
    for (const file of opened) {
      if (!this.snapshotsService.getOne(file)) {
        newlyOpened.push(file);
      }
    }

    /**
     * Now apply the mutations: wipe closed snapshots, drop closed ignore
     * entries, then fire captures for the newly opened files. Captures are
     * deferred to after the iteration completes, so a `wipeOne` re-capture of
     * the active file cannot interleave with these loops.
     */
    for (const file of closedSnapshots) {
      this.snapshotsService.wipeOne(file);
    }

    for (const file of closedIgnored) {
      this.snapshotsService.ignoreList.remove(file);
    }

    for (const file of newlyOpened) {
      void this.snapshotsService.capture(file);
    }
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
