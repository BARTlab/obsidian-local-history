import { BaseCommand } from '@/commands/base.command';
import { Inject } from '@/decorators/inject.decorator';
import type { SnapshotsService } from '@/services/snapshots.service';
import type { FunctionVoid } from '@/types';
import { type Command, Notice } from 'obsidian';

/**
 * Command that resets all line tracker snapshots.
 * Clears tracked changes for all files and shows a notification.
 *
 * @extends {BaseCommand}
 * @implements {Command}
 */
export class ResetLinesAllCommand extends BaseCommand implements Command {
  /**
   * Service for managing file snapshots.
   * Injected using the @Inject decorator.
   */
  @Inject('SnapshotsService')
  protected snapshotsService: SnapshotsService;

  /**
   * Unique identifier for this command.
   * Used by Obsidian to register and reference the command.
   */
  public id: string = 'tracker-reset-lines-all';

  /**
   * Display name for this command.
   * Shown in the Obsidian command palette.
   */
  public name: string = 'Reset all lines tracker snapshots';

  /**
   * Callback function executed when the command is triggered.
   * Deletes all snapshots and shows a notification.
   */
  public callback: FunctionVoid = (): void => {
    this.snapshotsService.wipe();

    new Notice('All snapshot data deleted');
  };
}
