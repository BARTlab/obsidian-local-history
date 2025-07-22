import type { BaseCommand } from '@/commands/base.command';
import { DebugCommand } from '@/commands/debug.command';
import { ResetLinesAllCommand } from '@/commands/reset-lines-all.command';
import { ResetLinesCommand } from '@/commands/reset-lines.command';
import { ShowDiffCommand } from '@/commands/show-diff.command';
import type LineChangeTrackerPlugin from '@/main';
import type { ClassConstructor, Service } from '@/types';
import type { Command } from 'obsidian';

/**
 * Service responsible for registering and managing plugin commands.
 * Handles the registration of commands with Obsidian and maintains
 * a collection of command instances.
 *
 * @implements {Service}
 */
export class CommandsService implements Service {
  /**
   * Map of command IDs to command instances.
   * Used to track registered commands and prevent duplicates.
   */
  protected instances: Map<string, Command> = new Map();

  /**
   * Creates a new instance of CommandsService.
   *
   * @param {LineChangeTrackerPlugin} plugin - The plugin instance
   */
  public constructor(
    protected plugin: LineChangeTrackerPlugin,
  ) {
  }

  /**
   * Initializes the service by registering all plugin commands.
   * Called during plugin initialization.
   */
  public init(): void {
    this.register(ResetLinesCommand);
    this.register(ResetLinesAllCommand);
    this.register(ShowDiffCommand);
    this.register(DebugCommand);
  }

  /**
   * Registers a command with Obsidian.
   * Creates an instance of the command, adds it to the instance map,
   * and registers it with the plugin.
   * Skip registration if a command with the same name already exists.
   *
   * @template T - The command type, extending both BaseCommand and Obsidian Command
   * @param {ClassConstructor<T>} ClsCConstructor - The command class constructor
   */
  protected register<T extends BaseCommand & Command>(ClsCConstructor: ClassConstructor<T>): void {
    const command: BaseCommand & Command = this.factory<T>(ClsCConstructor);

    if (this.instances.has(command.name)) {
      return;
    }

    this.instances.set(command.id, command);
    this.plugin.addCommand(command);
  }

  /**
   * Creates a new instance of a command.
   * Factory method that instantiates commands with the plugin instance.
   *
   * @template T - The command type, extending both BaseCommand and Obsidian Command
   * @param {ClassConstructor<T>} ClsCConstructor - The command class constructor
   * @return {Command} A new instance of the command
   */
  protected factory<T extends BaseCommand & Command>(ClsCConstructor: ClassConstructor<T>): BaseCommand & Command {
    return new ClsCConstructor(this.plugin);
  }
}
