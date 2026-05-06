import { BaseCommand } from '@/commands/base.command';
import { Inject } from '@/decorators/inject.decorator';
import { NavigationHelper } from '@/helpers/navigation.helper';
import type { SnapshotsService } from '@/services/snapshots.service';
import type { FileSnapshot } from '@/snapshots/file.snapshot';
import { type Command, type Editor, Notice } from 'obsidian';

/**
 * Command that moves the cursor to the next changed line in the current
 * document, relative to the cursor's current position. Wraps to the first
 * changed line when the cursor is at or past the last one. Does nothing (beyond
 * a brief notice) when the document has no tracked changes.
 *
 * @extends {BaseCommand}
 * @implements {Command}
 */
export class GoToNextChangeCommand extends BaseCommand implements Command {
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
  public id: string = 'tracker-go-to-next-change';

  /**
   * Display name for this command.
   * Shown in the Obsidian command palette.
   */
  public name: string = 'Go to next change';

  /**
   * Callback executed when the command runs in an editor context.
   * Resolves the next changed line from the current snapshot and moves the
   * cursor there. No default hotkey is assigned, per Obsidian policy.
   *
   * @param {Editor} editor - The active editor the command runs against
   */
  public editorCallback = (editor: Editor): void => {
    const snapshot: FileSnapshot | null = this.snapshotsService.getOne();
    const positions: number[] = snapshot?.getChangedPositions() ?? [];

    if (positions.length === 0) {
      new Notice('No changes to navigate');

      return;
    }

    const target: number | null = NavigationHelper.target(positions, editor.getCursor().line, 'next');

    if (target === null) {
      return;
    }

    NavigationHelper.moveCursor(editor, target);
  };
}
