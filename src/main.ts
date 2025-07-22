import 'reflect-metadata';
import { CommandsService } from '@/services/commands.service';
import { EventsService } from '@/services/events.service';
import { ExtensionsService } from '@/services/extensions.service';
import { ModalsService } from '@/services/modals.service';
import { SettingsService } from '@/services/settings.service';
import { SnapshotsService } from '@/services/snapshots.service';
import { StatusbarService } from '@/services/statusbar.service';
import { StylesService } from '@/services/styles.service';
import { type ClassConstructor, type Service } from '@/types';
import type { EditorView } from '@codemirror/view';
import EventEmitter from 'eventemitter3';
import { isFunction, isString } from 'lodash-es';
import {
  type App,
  type Editor,
  MarkdownView,
  Plugin,
  type PluginManifest,
  type TFile,
  type WorkspaceLeaf
} from 'obsidian';

/**
 * Main plugin class for the Line Change Tracker.
 * Tracks line changes in Obsidian documents and provides visual indicators
 * for added, modified, and removed lines.
 *
 * @extends Plugin
 */
export default class LineChangeTrackerPlugin extends Plugin {
  /**
   * Event emitter used for internal plugin communication.
   * Services can subscribe to events and emit events to communicate with each other.
   */
  protected emitter: EventEmitter = new EventEmitter();

  /**
   * Container for all registered services.
   * Maps service class constructors to their instances.
   */
  protected container: Map<ClassConstructor<Service>, Service> = new Map();

  /**
   * Creates a new instance of the LineChangeTrackerPlugin.
   * Registers all required services during initialization.
   *
   * @param {App} app - The Obsidian app instance
   * @param {PluginManifest} manifest - The plugin manifest
   */
  public constructor(app: App, manifest: PluginManifest) {
    super(app, manifest);

    // todo: implement a dependency system?
    this.registerService(SettingsService);
    this.registerService(StylesService);
    this.registerService(ModalsService);
    this.registerService(ExtensionsService);
    this.registerService(StatusbarService);
    this.registerService(CommandsService);
    this.registerService(EventsService);
    this.registerService(SnapshotsService);
  }

  /**
   * Registers a service with the plugin.
   * Creates an instance of the service, stores it in the container,
   * and sets up event listeners for methods decorated with @On.
   *
   * @template T - The service type
   * @param {ClassConstructor<T>} provider - The service class constructor
   */
  public registerService<
    T extends {} = Service
  >(provider: ClassConstructor<T>): void {
    // eslint-disable-next-line new-cap
    const inst = new provider(this);

    this.container.set(provider, inst);

    for (const prop of Object.getOwnPropertyNames(Object.getPrototypeOf(inst))) {
      const event: { name: string } | undefined = Reflect.getMetadata('ON_EVENT', inst, prop);
      const inject: string | undefined = Reflect.getMetadata('INJECT', inst, prop);

      if (!inject && event && prop in inst) {
        const method: unknown = (inst as Record<string, unknown>)[prop];

        if (isFunction(method)) {
          this.emitter.on(event.name, method as (...args: unknown[]) => void, inst);
        }
      }
    }
  }

  /**
   * Retrieves a service from the container.
   * Can look up services by class constructor or by class name.
   *
   * @template T - The service type
   * @param {ClassConstructor<T> | string} key - The service class constructor or class name
   * @return {T} The service instance
   * @throws Error if the service is not registered
   */
  public get<T extends {} = Service>(key: ClassConstructor<T> | string): T {
    if (!key) {
      throw new Error('Service cannot be empty');
    }

    const type: ClassConstructor<unknown> = isString(key)
      ? [...this.container.keys()].find((item: ClassConstructor<unknown>): boolean => item.name === key)
      : key;

    const service: T = this.container.get(type) as T;

    if (!service) {
      throw new Error(`Service '${type.name}' not registered`);
    }

    return service;
  }

  /**
   * Lifecycle method called when the plugin is loaded.
   * Initializes and loads all registered services.
   *
   * @return {Promise<void>} A promise that resolves when all services are loaded
   */
  public async onload(): Promise<void> {
    await this.exec('init');
    await this.exec('load');
  }

  /**
   * Lifecycle method called when the plugin is unloaded.
   * Unloads all registered services.
   *
   * @return {Promise<void>} A promise that resolves when all services are unloaded
   */
  public onunload(): Promise<void> {
    return this.exec('unload');
  }

  /**
   * Executes a method on all registered services.
   * Used for lifecycle management (init, load, unload).
   *
   * @param {string} method - The method name to execute on each service
   * @return {Promise<void>} A promise that resolves when all method executions are complete
   */
  protected async exec(method: keyof Service): Promise<void> {
    for (const provider of [...this.container.values()]) {
      if (method in provider && isFunction(provider[method])) {
        await provider[method]();
      }
    }
  }

  /**
   * Emits an event with the given name and payload.
   *
   * @param {string} name - The name of the event to emit
   * @param {unknown[]} payload - Additional data to pass with the event
   * @return {boolean} True if the event had listeners, false otherwise
   */
  public emit(name: string, ...payload: unknown[]): boolean {
    return this.emitter.emit(name, payload);
  }

  /**
   * Registers an event listener for the specified event.
   *
   * @param {string} name - The name of the event to listen for
   * @param {Function} fn - The callback function to execute when the event is emitted
   * @param {unknown} context - The context to bind the callback function to
   * @return {EventEmitter<string | symbol, unknown>} The event emitter instance for chaining
   */
  public on(
    name: string,
    fn: (...args: unknown[]) => void,
    context?: unknown
  ): EventEmitter<string | symbol, unknown> {
    return this.emitter.on(name, fn, context);
  }

  /**
   * Removes an event listener for the specified event.
   *
   * @param {string} name - The name of the event to remove the listener from
   * @param {Function} fn - The callback function to remove
   * @param {unknown} context - The context that was used when the listener was added
   * @return {EventEmitter<string | symbol, unknown>} The event emitter instance for chaining
   */
  public off(
    name: string,
    fn: (...args: unknown[]) => void,
    context?: unknown
  ): EventEmitter<string | symbol, unknown> {
    return this.emitter.off(name, fn, context);
  }

  /**
   * Forces an update of the current editor view.
   * Dispatches an empty transaction to trigger a refresh.
   */
  public forceUpdateEditor(): void {
    this.getResentEditorView()?.dispatch({
      effects: [],
      changes: [],
    });
  }

  /**
   * Gets the active editor view.
   *
   * @return {EditorView | null} The active CodeMirror editor view, or null if none is active
   */
  public getActiveEditorView(): EditorView | null {
    return (this.getActiveViewOfType()?.editor as Editor & { cm?: EditorView })?.cm ?? null;
  }

  /**
   * Gets the most recently used editor view.
   *
   * @return {EditorView | null} The most recent CodeMirror editor view, or null if none exists
   */
  public getResentEditorView(): EditorView | null {
    const view: MarkdownView = this.app.workspace.getMostRecentLeaf().view as MarkdownView;

    return (view?.editor as Editor & { cm?: EditorView })?.cm ?? null;
  }

  /**
   * Gets the active Markdown view.
   *
   * @return {MarkdownView | null} The active markdown view, or null if none is active
   */
  public getActiveViewOfType(): MarkdownView | null {
    return this.app.workspace.getActiveViewOfType(MarkdownView);
  }

  /**
   * Gets the active file.
   *
   * @return {TFile | null} The active file, or null if none is active
   */
  public getActiveFile(): TFile | null {
    return this.app.workspace.getActiveFile();
  }

  /**
   * Gets all Markdown files currently open in the workspace.
   *
   * @return {Set<TFile>} A set of all open Markdown files
   */
  public getWorkspaceFiles(): Set<TFile> {
    return new Set(
      this.app.workspace
        .getLeavesOfType('markdown')
        .map((leaf: WorkspaceLeaf) => (leaf.view as MarkdownView)?.file)
    );
  }
}
