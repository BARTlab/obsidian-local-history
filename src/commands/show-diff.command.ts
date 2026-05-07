import { BaseCommand } from '@/commands/base.command';
import { Inject } from '@/decorators/inject.decorator';
import type { ModalsService } from '@/services/modals.service';
import type { Command } from 'obsidian';

/**
 * Command that shows a diff view of all changes in the current document.
 * Opens a modal dialog displaying the history of changes for the active file.
 *
 * Uses `checkCallback` (keyed off the active file's snapshot) rather than
 * `editorCallback`, so the command stays available whenever the active file has
 * tracked history, regardless of view mode. In reading (preview) mode there is
 * no editor, so an `editorCallback` command would be silently disabled; the diff
 * modal itself is editor-independent and opens the same way in reading mode. The
 * inline line highlights remain editor-only (a documented limitation).
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
   * Callback that both gates and runs the command.
   * When `checking` is true it reports whether the command is available (the
   * active file has a snapshot), which lets Obsidian show it in reading mode too.
   * When `checking` is false it opens the diff modal for the active file. Returns
   * the availability either way so Obsidian can enable or hide the entry.
   *
   * @param {boolean} checking - True when Obsidian is only querying availability
   * @return {boolean} True if the command is available for the active file
   */
  public checkCallback = (checking: boolean): boolean => {
    const canDiff: boolean = this.modalService.canDiff();

    if (checking) {
      return canDiff;
    }

    return this.modalService.diff();
  };
}
