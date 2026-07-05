import 'reflect-metadata';
import { RECENT_CHANGES_VIEW_TYPE, VAULT_CHANGES_VIEW_TYPE } from '@/consts';
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
import { ServiceContainer } from '@/services/container';
import { type ServiceToken, TOKENS } from '@/services/tokens';
import { ReadingModeIndicatorService } from '@/services/reading-mode-indicator.service';
import { PropertyDecoratorService } from '@/services/property-decorator.service';
import { TreeTabDecoratorService } from '@/services/tree-tab-decorator.service';
import { VersionActionsService } from '@/services/version-actions.service';
import type { TranslationVars } from '@/types';
import { RecentChangesView } from '@/views/recent-changes.view';
import { VaultChangesView } from '@/views/vault-changes.view';
import type { EditorView } from '@codemirror/view';
import EventEmitter from 'eventemitter3';
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
   * True only between a successful `onload` and the next `onunload`/teardown.
   * Editor extensions and workspace event handlers live in Obsidian's lifecycle,
   * not the container's, so they can fire before services are up or after the
   * instance is torn down (e.g. a stale CodeMirror layer from a previous load
   * re-measuring). Those surfaces gate on this flag and no-op when it is false,
   * instead of resolving an injected service against a half-built container.
   */
  protected ready: boolean = false;

  /**
   * Owns every registered service under one token-keyed map and runs their
   * lifecycle. The plugin composes it (passing the emitter for @On wiring and
   * itself as the service-constructor host) and delegates resolution and
   * lifecycle to it, holding no DI map of its own.
   */
  private readonly serviceContainer: ServiceContainer = new ServiceContainer(this.emitter, this);

  /**
   * Creates a new instance of the LineChangeTrackerPlugin.
   * Registers all required services during initialization.
   *
   * @param {App} app - The Obsidian app instance
   * @param {PluginManifest} manifest - The plugin manifest
   */
  public constructor(app: App, manifest: PluginManifest) {
    super(app, manifest);

    this.serviceContainer.register(SettingsService, TOKENS.settings);
    this.serviceContainer.register(I18nService, TOKENS.i18n);
    this.serviceContainer.register(StylesService, TOKENS.styles);
    this.serviceContainer.register(ModalsService, TOKENS.modals);
    this.serviceContainer.register(ExtensionsService, TOKENS.extensions);
    this.serviceContainer.register(StatusbarService, TOKENS.statusbar);
    this.serviceContainer.register(CommandsService, TOKENS.commands);
    this.serviceContainer.register(EventsService, TOKENS.events);
    this.serviceContainer.register(SnapshotsService, TOKENS.snapshots);
    this.serviceContainer.register(VersionActionsService, TOKENS.versionActions);
    this.serviceContainer.register(PersistenceService, TOKENS.persistence);
    this.serviceContainer.register(TreeTabDecoratorService, TOKENS.treeTabDecorator);
    this.serviceContainer.register(PropertyDecoratorService, TOKENS.propertyDecorator);
    this.serviceContainer.register(ReadingModeIndicatorService, TOKENS.readingModeIndicator);
  }

  /**
   * Resolves a registered service by its stable token, delegating to the
   * container. Injected consumers reach this through the plugin they hold.
   *
   * @template T - The service type
   * @param {ServiceToken<T>} token - The token to resolve
   * @return {T} The service instance
   * @throws Error if no service is registered under the token
   */
  public get<T extends {}>(token: ServiceToken<T>): T {
    return this.serviceContainer.get(token);
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
    return this.get(TOKENS.i18n).t(key, vars);
  }

  /**
   * Lifecycle method called when the plugin is loaded.
   * Initializes and loads all registered services.
   *
   * @return {Promise<void>} A promise that resolves when all services are loaded
   */
  public async onload(): Promise<void> {
    const initFailed: boolean = await this.serviceContainer.exec('init');

    if (initFailed) {
      await this.serviceContainer.teardown();

      return;
    }

    const loadFailed: boolean = await this.serviceContainer.exec('load');

    if (loadFailed) {
      await this.serviceContainer.teardown();

      return;
    }

    this.registerView(
      RECENT_CHANGES_VIEW_TYPE,
      (leaf: WorkspaceLeaf): RecentChangesView => new RecentChangesView(leaf, this),
    );

    this.registerView(
      VAULT_CHANGES_VIEW_TYPE,
      (leaf: WorkspaceLeaf): VaultChangesView => new VaultChangesView(leaf, this),
    );

    this.addRibbonIcon('folder-git-2', this.t('command.open-vault-changes'), (): void => {
      void this.revealVaultChanges();
    });

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

    await this.serviceContainer.exec('unload');
  }

  /**
   * Emits an event with the given name and payload.
   *
   * @return {boolean} True if the event had listeners, false otherwise
   */
  public emit(name: string, ...payload: unknown[]): boolean {
    return this.emitter.emit(name, ...payload);
  }

  /**
   * Registers an event listener for the specified event.
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
   * Reveals the Recent changes panel in the right sidebar.
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
   * Reveals the vault-wide changes panel in the right sidebar.
   *
   * Mirrors {@link revealRecentChanges}: reuses an existing leaf when one is
   * open so a second invocation focuses the panel rather than spawning a
   * duplicate, and falls back to a fresh right-sidebar leaf otherwise. When the
   * right sidebar is unavailable the call resolves silently so the ribbon and
   * command entry points stay safe.
   *
   * @return {Promise<void>} Resolves once the leaf is created and revealed
   */
  public async revealVaultChanges(): Promise<void> {
    const existing: WorkspaceLeaf[] = this.app.workspace.getLeavesOfType(VAULT_CHANGES_VIEW_TYPE);

    if (existing.length > 0) {
      await this.app.workspace.revealLeaf(existing[0]);

      return;
    }

    const leaf: WorkspaceLeaf | null = this.app.workspace.getRightLeaf(false);

    if (!leaf) {
      return;
    }

    await leaf.setViewState({ type: VAULT_CHANGES_VIEW_TYPE, active: true });
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
        .map((leaf: WorkspaceLeaf): TFile | null => (leaf.view as MarkdownView)?.file)
        .filter((file: TFile | null): file is TFile => file !== null)
    );
  }
}
