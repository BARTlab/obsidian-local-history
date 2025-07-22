import type { BaseEvent } from '@/events/base.event';
import { VaultCreateEvent } from '@/events/vault/create.event';
import { VaultModifyEvent } from '@/events/vault/modify.event';
import { WorkspaceActiveLeafChangeEvent } from '@/events/workspace/active-leaf-change.event';
import { WorkspaceEditorMenuEvent } from '@/events/workspace/editor-menu.event';
import { WorkspaceFileOpenEvent } from '@/events/workspace/file-open.event';
import { WorkspaceFilesMenuEvent } from '@/events/workspace/files-menu.event';
import { WorkspaceLayoutChangeEvent } from '@/events/workspace/layout-change.event';
import type LineChangeTrackerPlugin from '@/main';
import type { ClassConstructor, Service } from '@/types';

/**
 * Service responsible for registering and managing plugin events.
 * Handles the registration of event listeners with Obsidian and maintains
 * a collection of event instances.
 *
 * @implements {Service}
 */
export class EventsService implements Service {
  /**
   * Set of event instances.
   * Used to track registered events and prevent duplicates.
   */
  protected instances: Set<BaseEvent> = new Set();

  /**
   * Creates a new instance of EventsService.
   *
   * @param {LineChangeTrackerPlugin} plugin - The plugin instance
   */
  public constructor(
    protected plugin: LineChangeTrackerPlugin,
  ) {
  }

  /**
   * Initializes the service by registering all plugin events.
   * Called during plugin initialization.
   */
  public init(): void {
    this.register(WorkspaceActiveLeafChangeEvent);
    this.register(WorkspaceFileOpenEvent);
    this.register(WorkspaceLayoutChangeEvent);
    this.register(WorkspaceEditorMenuEvent);
    this.register(WorkspaceFilesMenuEvent);
    this.register(VaultModifyEvent);
    this.register(VaultCreateEvent);
  }

  /**
   * Registers an event with Obsidian.
   * Creates an instance of the event, adds it to the instance set,
   * and registers it with the plugin.
   * Skip registration if the event already exists in the set.
   *
   * @template T - The event type, extending BaseEvent
   * @param {ClassConstructor<T>} ClsCConstructor - The event class constructor
   */
  protected register<T extends BaseEvent>(ClsCConstructor: ClassConstructor<T>): void {
    const event: BaseEvent = this.factory<T>(ClsCConstructor);

    if (this.instances.has(event)) {
      return;
    }

    this.instances.add(event);
    this.plugin.registerEvent(event.register());
  }

  /**
   * Creates a new instance of an event.
   * Factory method that instantiates events with the plugin instance.
   *
   * @template T - The event type, extending BaseEvent
   * @param {ClassConstructor<T>} ClsCConstructor - The event class constructor
   * @return {BaseEvent} A new instance of the event
   */
  protected factory<T extends BaseEvent>(ClsCConstructor: ClassConstructor<T>): BaseEvent {
    return new ClsCConstructor(this.plugin);
  }
}
