import { BaseCommand } from '@/commands/base.command';
import { Inject } from '@/decorators/inject.decorator';
import type { SnapshotsService } from '@/services/snapshots.service';
import type { FunctionVoid } from '@/types';
import { type Command, Notice } from 'obsidian';

/**
 * Command that resets the line tracker snapshot for the current document.
 * Clears all tracked changes for the active file and shows a notification.
 *
 * @extends {BaseCommand}
 * @implements {Command}
 */
export class ResetLinesCommand extends BaseCommand implements Command {
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
  public id: string = 'tracker-reset-lines';

  /**
   * Display name for this command.
   * Shown in the Obsidian command palette.
   */
  public name: string = 'Reset lines tracker snapshot of current document';

  /**
   * Callback function executed when the command is triggered in an editor context.
   * Deletes the snapshot for the current document and shows a notification.
   */
  public editorCallback: FunctionVoid = (): void => {
    this.snapshotsService.wipeOne();

    new Notice('Current snapshot data deleted');
  };
}
