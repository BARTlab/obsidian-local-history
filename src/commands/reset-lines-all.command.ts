import { Inject } from '@/decorators/inject.decorator';
import type LineChangeTrackerPlugin from '@/main';
import type { SnapshotsService } from '@/services/snapshots.service';
import { TOKENS } from '@/services/tokens';
import type { FunctionVoid } from '@/types';
import { type Command, Notice } from 'obsidian';

/**
 * Command that resets all line tracker snapshots.
 * Clears tracked changes for all files and shows a notification.
 *
 * @implements {Command}
 */
export class ResetLinesAllCommand implements Command {
  /**
   * Unique identifier for this command.
   * Used by Obsidian to register and reference the command.
   */
  public id: string = 'tracker-reset-lines-all';

  /**
   * Display name for this command, localized through the plugin translator.
   * Shown in the Obsidian command palette.
   */
  public name: string = this.plugin.t('command.reset-lines-all');

  /**
   * Callback function executed when the command is triggered.
   * Deletes all snapshots and shows a notification.
   */
  public callback: FunctionVoid = (): void => {
    this.snapshotsService.wipe();

    new Notice(this.plugin.t('notice.all-snapshots-deleted'));
  };

  @Inject(TOKENS.snapshots)
  protected snapshotsService!: SnapshotsService;

  public constructor(
    public plugin: LineChangeTrackerPlugin,
  ) {
  }
}
