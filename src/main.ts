import 'reflect-metadata';
import { RECENT_CHANGES_VIEW_TYPE } from '@/consts';
import { refreshDecorationsEffect } from '@/extensions/refresh.effect';
import { CommandsService } from '@/services/commands.service';
import { EventsService } from '@/services/events.service';
import { ExtensionsService } from '@/services/extensions.service';
import { I18nService } from '@/services/i18n.service';
import { ModalsService } from '@/services/modals.service';
import { PersistenceService } from '@/services/persistence.service';
import { SettingsService } from '@/services/settings.service';
import { SnapshotsService } from '@/services/snapshots.service';
import { StatusbarService } from '@/services/statusbar.service';
import { StylesService } from '@/services/styles.service';
import { type ServiceToken, TOKENS, tokenName } from '@/services/tokens';
import { PropertyDecoratorService } from '@/services/property-decorator.service';
import { TreeTabDecoratorService } from '@/services/tree-tab-decorator.service';
import { VersionActionsService } from '@/services/version-actions.service';
import { type ClassConstructor, type Service, type TranslationVars } from '@/types';
import { RecentChangesView } from '@/views/recent-changes.view';
import type { EditorView } from '@codemirror/view';
import EventEmitter from 'eventemitter3';
import { isFunction } from 'lodash-es';
import {
  type App,
  type Editor,
  MarkdownView,
  Plugin,
  type PluginManifest,
  TFile,
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
   * Token-keyed view of the same service instances as {@link container}.
   * Maps each service's stable {@link ServiceToken} (a symbol, minification-safe)
   * to its instance, so resolution by token does not depend on `constructor.name`
   * surviving the bundle. Both maps point at the identical instances; they are
   * populated together in {@link registerService}. The token path is the
   * migration target; the legacy class/string paths are removed in C5.
   */
  protected tokenContainer: Map<symbol, Service> = new Map();

  /**
   * Services whose `init` has resolved successfully in the current lifecycle.
   * Tracked so a fatal init can tear down only what was actually brought up,
   * in reverse registration order (ADR-08-C).
   */
  protected initialized: Service[] = [];

  /**
   * True only between a successful `onload` and the next `onunload`/teardown.
   * Editor extensions and workspace event handlers live in Obsidian's lifecycle,
   * not the container's, so they can fire before services are up or after the
   * instance is torn down (e.g. a stale CodeMirror layer from a previous load
   * re-measuring). Those surfaces gate on this flag and no-op when it is false,
   * instead of resolving an injected service against a half-built container.
   */
  protected ready: boolean = false;

  /**
   * Creates a new instance of the LineChangeTrackerPlugin.
   * Registers all required services during initialization.
   *
   * @param {App} app - The Obsidian app instance
   * @param {PluginManifest} manifest - The plugin manifest
   */
  public constructor(app: App, manifest: PluginManifest) {
    super(app, manifest);

    this.registerService(SettingsService, TOKENS.settings);
    this.registerService(I18nService, TOKENS.i18n);
    this.registerService(StylesService, TOKENS.styles);
    this.registerService(ModalsService, TOKENS.modals);
    this.registerService(ExtensionsService, TOKENS.extensions);
    this.registerService(StatusbarService, TOKENS.statusbar);
    this.registerService(CommandsService, TOKENS.commands);
    this.registerService(EventsService, TOKENS.events);
    this.registerService(SnapshotsService, TOKENS.snapshots);
    this.registerService(VersionActionsService, TOKENS.versionActions);
    this.registerService(PersistenceService, TOKENS.persistence);
    this.registerService(TreeTabDecoratorService, TOKENS.treeTabDecorator);
    this.registerService(PropertyDecoratorService, TOKENS.propertyDecorator);
  }

  /**
   * Registers a service with the plugin.
   * Creates an instance of the service, stores it in the container under both
   * its class constructor and its stable token, and sets up event listeners for
   * methods decorated with @On.
   *
   * @template T - The service type
   * @param {ClassConstructor<T>} provider - The service class constructor
   * @param {ServiceToken<T>} [tokenKey] - The stable token to key the instance
   *   by. Optional only for the back-compat window: every `main.ts` registration
   *   passes one, and the token map is what lets resolution stop depending on
   *   `constructor.name` once consumers migrate (C5).
   */
  public registerService<
    T extends {} = Service
  >(provider: ClassConstructor<T>, tokenKey?: ServiceToken<T>): void {
    // eslint-disable-next-line new-cap
    const inst = new provider(this);

    this.container.set(provider, inst);

    if (tokenKey) {
      this.tokenContainer.set(tokenKey, inst);
    }

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
   *
   * Resolution order:
   * 1. A {@link ServiceToken} (symbol) resolves directly from the token map -
   *    the stable, minification-safe path every consumer uses.
   * 2. A class constructor resolves from the class-keyed map by identity.
   *
   * Both paths are independent of `constructor.name`, so resolution no longer
   * depends on class names surviving minification (the bundle drops `keepNames`).
   *
   * @template T - The service type
   * @param {ServiceToken<T> | ClassConstructor<T>} key - The token or class
   *   constructor to resolve
   * @return {T} The service instance
   * @throws Error if the service is not registered
   */
  public get<T extends {} = Service>(
    key: ServiceToken<T> | ClassConstructor<T>
  ): T {
    if (!key) {
      throw new Error('Service cannot be empty');
    }

    const service: T | undefined = typeof key === 'symbol'
      ? this.tokenContainer.get(key) as T | undefined
      : this.container.get(key) as T | undefined;

    if (!service) {
      const label: string = typeof key === 'symbol'
        ? (tokenName(key) ?? key.toString())
        : key.name;

      throw new Error(`Service '${label}' not registered`);
    }

    return service;
  }

  /**
   * Whether the plugin finished loading and has not been torn down. Surfaces
   * that run outside the container lifecycle (editor extensions, workspace
   * event handlers) check this before resolving injected services, so a call
   * arriving before load completes or after unload is a no-op rather than a
   * crash on an unresolved service.
   *
   * @return {boolean} True while the plugin is fully loaded
   */
  public isReady(): boolean {
    return this.ready;
  }

  /**
   * Translates a dotted localization key to a user-facing string in Obsidian's
   * selected language, falling back to English. A thin delegate to I18nService so
   * every surface (settings, modal, commands, notices) can localize through the
   * plugin it already holds without injecting the service itself.
   *
   * @param {string} key - The dotted translation key (e.g. `modal.restore-original`)
   * @param {TranslationVars} [vars] - Values for `{name}` placeholders
   * @return {string} The localized, interpolated string
   */
  public t(key: string, vars?: TranslationVars): string {
    return this.get(I18nService).t(key, vars);
  }

  /**
   * Lifecycle method called when the plugin is loaded.
   * Initializes and loads all registered services.
   *
   * @return {Promise<void>} A promise that resolves when all services are loaded
   */
  public async onload(): Promise<void> {
    const initFailed: boolean = await this.exec('init');

    if (initFailed) {
      await this.teardown();

      return;
    }

    const loadFailed: boolean = await this.exec('load');

    if (loadFailed) {
      await this.teardown();

      return;
    }

    this.registerView(
      RECENT_CHANGES_VIEW_TYPE,
      (leaf: WorkspaceLeaf): RecentChangesView => new RecentChangesView(leaf, this),
    );

    this.ready = true;
    this.forceUpdateEditor();
  }

  /**
   * Lifecycle method called when the plugin is unloaded.
   * Unloads all registered services.
   *
   * @return {Promise<void>} A promise that resolves when all services are unloaded
   */
  public async onunload(): Promise<void> {
    this.ready = false;

    await this.exec('unload');
  }

  /**
   * Executes a method on all registered services in registration order.
   * Each per-service call is isolated in try/catch so one failure does not
   * abort the loop; remaining services still get a chance to run (ADR-08-C).
   * For `init`, a successful call records the service in `initialized` so a
   * subsequent fatal can tear down only what is actually up. `unload` clears
   * the corresponding entry as the service goes down.
   *
   * @param {string} method - The method name to execute on each service
   * @return {Promise<boolean>} True when at least one service threw, so the
   *   caller can trigger teardown of the partial container.
   */
  protected async exec(method: keyof Service): Promise<boolean> {
    let failed: boolean = false;

    for (const provider of [...this.container.values()]) {
      if (method in provider && isFunction(provider[method])) {
        try {
          await provider[method]();

          if (method === 'init') {
            this.initialized.push(provider);
          } else if (method === 'unload') {
            const idx: number = this.initialized.indexOf(provider);

            if (idx >= 0) {
              this.initialized.splice(idx, 1);
            }
          }
        } catch (error) {
          failed = true;
          console.error(
            `[obsidian-local-history] ${provider.constructor.name}.${method} failed:`,
            error,
          );
        }
      }
    }

    return failed;
  }

  /**
   * Tears down services that were brought up by a partial `init`/`load`, in
   * reverse registration order, so a fatal lifecycle failure never leaves a
   * half-loaded plugin behind (ADR-08-C). Each per-service `unload` is
   * isolated so one teardown failure does not block the rest.
   *
   * @return {Promise<void>} Resolves once teardown is complete.
   */
  protected async teardown(): Promise<void> {
    this.ready = false;

    for (const provider of [...this.initialized].reverse()) {
      if ('unload' in provider && isFunction(provider.unload)) {
        try {
          await provider.unload();
        } catch (error) {
          console.error(
            `[obsidian-local-history] ${provider.constructor.name}.unload failed during teardown:`,
            error,
          );
        }
      }
    }

    this.initialized = [];
  }

  /**
   * Emits an event with the given name and payload.
   *
   * @param {string} name - The name of the event to emit
   * @param {unknown[]} payload - Additional data to pass with the event
   * @return {boolean} True if the event had listeners, false otherwise
   */
  public emit(name: string, ...payload: unknown[]): boolean {
    return this.emitter.emit(name, ...payload);
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
   * Dispatches a refresh effect so decoration extensions rebuild even though
   * the document did not change.
   */
  public forceUpdateEditor(): void {
    this.getRecentEditorView()?.dispatch({
      effects: [refreshDecorationsEffect.of(null)],
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
  public getRecentEditorView(): EditorView | null {
    const view: MarkdownView = this.app.workspace.getMostRecentLeaf()?.view as MarkdownView;

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
   * Resolves a vault file by its path.
   * Returns null when nothing exists at the path or the entry is a folder, so
   * callers can safely skip stale references (e.g. after a file was deleted
   * while the plugin was unloaded).
   *
   * @param {string} path - The vault-relative path to resolve
   * @return {TFile | null} The matching file, or null if none
   */
  public getFileByPath(path: string): TFile | null {
    const file = this.app.vault.getAbstractFileByPath(path);

    return file instanceof TFile ? file : null;
  }

  /**
   * Reveals the Recent changes panel in the right sidebar (D3).
   *
   * Reuses an existing leaf when one is already open so a second invocation
   * focuses the panel rather than spawning a duplicate. Falls back to creating
   * a fresh right-sidebar leaf when none exists; if the right sidebar is
   * unavailable (no leaf granted), the call resolves silently without an
   * error so menu and command entry points stay safe.
   *
   * @return {Promise<void>} Resolves once the leaf is created and revealed
   */
  public async revealRecentChanges(): Promise<void> {
    const existing: WorkspaceLeaf[] = this.app.workspace.getLeavesOfType(RECENT_CHANGES_VIEW_TYPE);

    if (existing.length > 0) {
      await this.app.workspace.revealLeaf(existing[0]);

      return;
    }

    const leaf: WorkspaceLeaf | null = this.app.workspace.getRightLeaf(false);

    if (!leaf) {
      return;
    }

    await leaf.setViewState({ type: RECENT_CHANGES_VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
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
