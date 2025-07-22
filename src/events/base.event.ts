import type LineChangeTrackerPlugin from '@/main';
import type { EventTriggerElement, ObsidianEventName } from '@/types';
import type { EventRef, Vault, Workspace } from 'obsidian';

/**
 * Base abstract class for all event handlers in the plugin.
 * Provides common functionality for registering and unregistering event handlers
 * with Obsidian's workspace and vault events.
 *
 * @implements {EventRef}
 */
export abstract class BaseEvent implements EventRef {
  /**
   * The name of the event to handle.
   * Must be in the format "type.name" (e.g., "workspace.file-open").
   */
  public abstract readonly name: ObsidianEventName;

  /**
   * Creates a new instance of BaseEvent.
   *
   * @param {LineChangeTrackerPlugin} plugin - The plugin instance that manages this event
   */
  public constructor(
    public plugin: LineChangeTrackerPlugin,
  ) {
  }

  /**
   * Event handler method to be implemented by subclasses.
   * Called when the event is triggered.
   *
   * @param args - Arguments passed by the event
   */
  public abstract handler(...args: unknown[]): void;

  /**
   * Gets the appropriate trigger element (workspace or vault) based on the event type.
   *
   * @param {string} type - The type of event trigger ("workspace" or "vault")
   * @return {EventTriggerElement} The corresponding trigger element
   * @throws Error if the trigger type is unknown
   */
  public getTrigger(type: string): EventTriggerElement {
    const trigger: Workspace | Vault = {
      workspace: this.plugin.app.workspace,
      vault: this.plugin.app.vault,
    }[type];

    if (!trigger) {
      throw new Error(`Unknown trigger type: ${type}`);
    }

    return trigger;
  }

  /**
   * Parses the event name into its component parts.
   * Splits the name into type and name components
   * (e.g., "workspace.file-open" -> {type: "workspace", name: "file-open"}).
   *
   * @return {Object} An object containing the type and name components
   * @throws Error if the event name is not in the correct format
   */
  public getTypeName(): { type: string; name: string } {
    const arr: string[] = this.name.split('.');

    if (arr.length !== 2) {
      throw new Error(`Invalid event name: ${this.name}`);
    }

    return { type: arr[0], name: arr[1] };
  }

  /**
   * Registers the event handler with Obsidian.
   * Uses the event name to determine the appropriate trigger and register the handler method.
   *
   * @return {EventRef} An EventRef that can be used to unregister the event
   */
  public register(): EventRef {
    const { name, type } = this.getTypeName();

    return this.getTrigger(type).on(
      name as string,
      this.handler,
      this,
    );
  }

  /**
   * Unregisters the event handler from Obsidian.
   * Removes the event listener to prevent memory leaks when the plugin is disabled.
   *
   * @return {void}
   */
  public unregister(): void {
    const { name, type } = this.getTypeName();

    return this.getTrigger(type).off(
      name as string,
      this.handler,
    );
  }
}
