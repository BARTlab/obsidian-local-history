import { BaseCommand } from '@/commands/base.command';
import { Inject } from '@/decorators/inject.decorator';
import type { ModalsService } from '@/services/modals.service';
import type { FunctionVoid } from '@/types';
import type { Command } from 'obsidian';

// todo: need command "add current file to history"
/**
 * Command that shows a diff view of all changes in the current document.
 * Opens a modal dialog displaying the history of changes for the active file.
 *
 * @extends {BaseCommand}
 * @implements {Command}
 */
export class ShowDiffCommand extends BaseCommand implements Command {
  /**
   * Service for managing modal dialogs.
   * Injected using the @Inject decorator.
   */
  @Inject('ModalsService')
  protected modalService: ModalsService;

  /**
   * Unique identifier for this command.
   * Used by Obsidian to register and reference the command.
   */
  public id: string = 'tracker-show-diff';

  /**
   * Display name for this command.
   * Shown in the Obsidian command palette.
   */
  public name: string = 'Show all changes of current document';

  /**
   * Callback function executed when the command is triggered in an editor context.
   * Opens a diff modal showing all changes in the current document.
   */
  public editorCallback: FunctionVoid = (): void => {
    this.modalService.diff();
  };
}
