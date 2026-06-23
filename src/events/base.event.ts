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
    const trigger: Workspace | Vault | undefined = {
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
   * Wraps the handler call in a try/catch and attaches a `.catch` to any
   * returned promise, so a sync throw or async rejection never escapes into
   * Obsidian's dispatch and never becomes an unhandled rejection. The original
   * handler signature stays untouched; subclasses still implement `handler`
   * normally.
   *
   * @return {EventRef} An EventRef that can be used to unregister the event
   */
  public register(): EventRef {
    const { name, type } = this.getTypeName();

    return this.getTrigger(type).on(
      name as string,
      this.dispatch.bind(this),
      this,
    );
  }

  /**
   * Routes an event call through a single try/catch so every handler failure
   * is logged with the event name and neither propagates synchronously nor
   * leaves an unhandled rejection. Async handlers attach `.catch` to the
   * returned promise.
   *
   * @param args - Arguments passed by the Obsidian event
   * @return {void}
   */
  protected dispatch(...args: unknown[]): void {
    try {
      const result: unknown = (this.handler as (...a: unknown[]) => unknown).apply(this, args);

      if (result && typeof (result as { then?: unknown }).then === 'function') {
        (result as Promise<unknown>).catch((error: unknown): void => {
          this.logError(error);
        });
      }
    } catch (error) {
      this.logError(error);
    }
  }

  /**
   * Logs a handler failure together with the originating event name so prod
   * debugging has a single, greppable line per failure.
   *
   * @param {unknown} error - The thrown value or rejection reason
   * @return {void}
   */
  protected logError(error: unknown): void {
    console.error(`Local history: event handler "${this.name}" failed`, error);
  }
}
