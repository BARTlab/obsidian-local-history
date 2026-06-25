import { ObsidianEvent } from '@/consts';
import { Inject } from '@/decorators/inject.decorator';
import { BaseEvent } from '@/events/base.event';
import type { SnapshotsService } from '@/services/snapshots.service';
import { TOKENS } from '@/services/tokens';
import type { ObsidianEventName } from '@/types';
import { type TAbstractFile, TFile } from 'obsidian';

/**
 * Event handler for Obsidian's vault modify event.
 * Routes file writes to `SnapshotsService.captureExternalChange` so external
 * sources (git pull, sync, an external editor) get captured as flagged
 * versions while editor flushes and the plugin's own revert writes are
 * filtered out by the hash guard inside the service.
 *
 * Registration is deferred to `onLayoutReady` alongside the other vault
 * events so the initial reads Obsidian performs during the startup file
 * scan do not produce phantom external captures (the hash guard already
 * matches at that point because state was just seeded).
 *
 * @extends {BaseEvent}
 */
export class VaultModifyEvent extends BaseEvent {
  /**
   * Service for managing file snapshots.
   * Injected using the @Inject decorator.
   */
  @Inject(TOKENS.snapshots)
  protected snapshotsService!: SnapshotsService;

  /**
   * The name of the Obsidian event to handle.
   * Set to the vault.modify event.
   */
  public readonly name: ObsidianEventName = ObsidianEvent.vault.modify;

  /**
   * Handles the vault modify event. Routes to
   * `SnapshotsService.scheduleExternalCapture` so a burst of modify events
   * for the same file (sync, git pull, an external save loop) collapses into
   * one debounced disk read + capture, and an overlapping follow-up modify
   * cannot start a second concurrent capture for the same path.
   * Skips non-file entries (folders).
   *
   * @param {TAbstractFile} file - The file that was modified in the vault
   */
  public handler(file: TAbstractFile): void {
    if (!(file instanceof TFile)) {
      return;
    }

    this.snapshotsService.scheduleExternalCapture(file);
  }
}
