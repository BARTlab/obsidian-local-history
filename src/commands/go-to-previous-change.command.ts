import { BaseCommand } from '@/commands/base.command';
import { NavigationDirection } from '@/consts';
import { Inject } from '@/decorators/inject.decorator';
import { NavigationHelper } from '@/helpers/navigation.helper';
import type { SnapshotsService } from '@/services/snapshots.service';
import { TOKENS } from '@/services/tokens';
import type { FileSnapshot } from '@/snapshots/file.snapshot';
import { type Command, type Editor, Notice } from 'obsidian';

/**
 * Command that moves the cursor to the previous changed line in the current
 * document, relative to the cursor's current position. Wraps to the last
 * changed line when the cursor is at or before the first one. Does nothing
 * (beyond a brief notice) when the document has no tracked changes.
 *
 * @extends {BaseCommand}
 * @implements {Command}
 */
export class GoToPreviousChangeCommand extends BaseCommand implements Command {
  /**
   * Service for managing file snapshots.
   * Injected using the @Inject decorator.
   */
  @Inject(TOKENS.snapshots)
  protected snapshotsService: SnapshotsService;

  /**
   * Unique identifier for this command.
   * Used by Obsidian to register and reference the command.
   */
  public id: string = 'tracker-go-to-previous-change';

  /**
   * Display name for this command, localized through the plugin translator.
   * Shown in the Obsidian command palette.
   */
  public name: string = this.plugin.t('command.go-to-previous-change');

  /**
   * Callback executed when the command runs in an editor context.
   * Resolves the previous changed line from the current snapshot and moves the
   * cursor there. No default hotkey is assigned, per Obsidian policy.
   *
   * @param {Editor} editor - The active editor the command runs against
   */
  public editorCallback = (editor: Editor): void => {
    const snapshot: FileSnapshot | null = this.snapshotsService.getOne();
    const positions: number[] = snapshot?.getChangedPositions() ?? [];

    if (positions.length === 0) {
      new Notice(this.plugin.t('notice.no-changes-to-navigate'));

      return;
    }

    const cursorLine: number = editor.getCursor().line;
    const target: number | null = NavigationHelper.target(positions, cursorLine, NavigationDirection.previous);

    if (target === null) {
      return;
    }

    NavigationHelper.moveCursor(editor, target);
  };
}
