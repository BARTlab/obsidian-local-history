import type LineChangeTrackerPlugin from '@/main';

/**
 * Base abstract class for all commands in the plugin.
 * Provides common functionality and properties for commands.
 */
export abstract class BaseCommand {
  /**
   * Creates a new instance of BaseCommand.
   *
   * @param {LineChangeTrackerPlugin} plugin - The plugin instance that manages this command
   */
  public constructor(
    protected plugin: LineChangeTrackerPlugin,
  ) {
  }
}
