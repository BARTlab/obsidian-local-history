import type { BaseEvent } from '@/events/base.event';
import { VaultCreateEvent } from '@/events/vault/create.event';
import { VaultDeleteEvent } from '@/events/vault/delete.event';
import { VaultModifyEvent } from '@/events/vault/modify.event';
import { VaultRenameEvent } from '@/events/vault/rename.event';
import { WorkspaceActiveLeafChangeEvent } from '@/events/workspace/active-leaf-change.event';
import { WorkspaceEditorMenuEvent } from '@/events/workspace/editor-menu.event';
import { WorkspaceFileOpenEvent } from '@/events/workspace/file-open.event';
import { WorkspaceFilesMenuEvent } from '@/events/workspace/files-menu.event';
import { WorkspaceLayoutChangeEvent } from '@/events/workspace/layout-change.event';
import { WorkspaceViewportMenuEvent } from '@/events/workspace/viewport-menu.event';
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
   * Map of event constructors to their instances.
   * Keyed by constructor reference (not `.name`) so the guard is
   * minification-safe. A name-string key would break if bundler
   * minification is ever enabled (different classes could collapse to the
   * same mangled name). The previous `Set<BaseEvent>` keyed by instance
   * identity never fired because {@link factory} always returns a fresh
   * instance.
   */
  protected instances: Map<ClassConstructor<BaseEvent>, BaseEvent> = new Map();

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
   *
   * Workspace events are registered immediately. Vault events are deferred to
   * `onLayoutReady` so the startup `create` burst Obsidian fires for existing
   * files does not reach the create handler and push real files into the
   * ignore list (which would silently stop tracking them after a restart).
   */
  public init(): void {
    this.registerWorkspaceEvents();
    this.plugin.app.workspace.onLayoutReady((): void => this.registerVaultEvents());
  }

  /**
   * Registers the workspace event handlers.
   * Safe to register during `onload`; these do not react to the startup file
   * scan in a way that corrupts plugin state.
   */
  protected registerWorkspaceEvents(): void {
    this.register(WorkspaceActiveLeafChangeEvent);
    this.register(WorkspaceFileOpenEvent);
    this.register(WorkspaceLayoutChangeEvent);
    this.register(WorkspaceEditorMenuEvent);
    this.register(WorkspaceViewportMenuEvent);
    this.register(WorkspaceFilesMenuEvent);
  }

  /**
   * Registers the vault event handlers.
   * Deferred to `onLayoutReady` so the initial `create` events Obsidian emits
   * for pre-existing files are not handled on a cold start (see {@link init}).
   */
  protected registerVaultEvents(): void {
    this.register(VaultCreateEvent);
    this.register(VaultRenameEvent);
    this.register(VaultDeleteEvent);
    this.register(VaultModifyEvent);
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
    if (this.instances.has(ClsCConstructor)) {
      return;
    }

    const event: BaseEvent = this.factory<T>(ClsCConstructor);

    this.instances.set(ClsCConstructor, event);
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
