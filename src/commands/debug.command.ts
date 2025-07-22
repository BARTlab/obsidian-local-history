import { BaseCommand } from '@/commands/base.command';
import { Inject } from '@/decorators/inject.decorator';
import { debug } from '@/helpers/debug.helper';
import type { SnapshotsService } from '@/services/snapshots.service';
import type { FunctionVoid } from '@/types';
import type { Command } from 'obsidian';

/**
 * Command that logs debug information to the console.
 * Provides a way to output plugin state and diagnostic information for debugging purposes.
 *
 * @extends {BaseCommand}
 * @implements {Command}
 */
export class DebugCommand extends BaseCommand implements Command {
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
  public id: string = 'tracker-debug';

  /**
   * Display name for this command.
   * Shown in the Obsidian command palette.
   */
  public name: string = 'Log to console debug information';

  /**
   * Callback function executed when the command is triggered.
   * Logs plugin information to the console for debugging.
   */
  public callback: FunctionVoid = (): void => {
    debug.info('Tracker debug information', {
      plugin: this.plugin,
      test: this.snapshotsService.getOne()?.selfTest() ?? null
    });
  };
}
