import { FolderTreeComponent } from '@/components/folder-tree.component';
import { ChangesLayout, type KeepHistory, PluginEvent, VAULT_CHANGES_VIEW_TYPE } from '@/consts';
import * as DomHelper from '@/helpers/dom.helper';
import { resolveOrigin } from '@/helpers/origin.helper';
import * as VaultChangesHelper from '@/helpers/vault-changes.helper';
import type LineChangeTrackerPlugin from '@/main';
import type { SettingsService } from '@/services/settings.service';
import type { SnapshotsService } from '@/services/snapshots.service';
import { TOKENS } from '@/services/tokens';
import type { FileSnapshot } from '@/snapshots/file.snapshot';
import type { FolderTreeEntry } from '@/types';
import {
  type IconName,
  ItemView,
  Notice,
  SearchComponent,
  setIcon,
  type TFile,
  type WorkspaceLeaf,
} from 'obsidian';

/**
 * Right-sidebar navigator listing every file the plugin still sees as changed
 * against the RESOLVED origin (see `resolveOrigin`): modified files, files born
 * under tracking (added), and deleted files kept as tombstones. Because it
 * diffs against the same origin the change map feeds the tree, gutter and tab
 * decorators, the panel lists exactly the set the tree paints at every `keep`
 * level - bounded by retention at `keep=persist` (so it survives a restart but
 * does not grow unbounded), session-scoped at `keep=file`/`app`. Unlike the
 * Recent changes panel (which times one active file's versions) this is
 * vault-wide (see {@link VaultChangesHelper}).
 *
 * The list is rendered by the shared {@link FolderTreeComponent}, in either a
 * nested folder tree or a flat file list (each file's path shown inline). The
 * layout is toggled from the header and persisted in settings. A name filter
 * narrows the list, and clicking a file opens it (a deleted file has no live
 * file to open, so it reports an inline notice instead). The panel re-renders on
 * every snapshot update so it never lags behind the vault.
 *
 * @extends {ItemView}
 */
export class VaultChangesView extends ItemView {
  /** The tree/flat renderer; mounted on open, disposed on close. */
  protected tree: FolderTreeComponent = new FolderTreeComponent();

  /** Search box narrowing the list by file name. Kept across renders. */
  protected searchComponent?: SearchComponent;

  /** Header toggle button selecting the nested-tree layout. */
  protected treeButton?: HTMLElement;

  /** Header toggle button selecting the flat-list layout. */
  protected flatButton?: HTMLElement;

  /**
   * Creates a new instance of VaultChangesView.
   *
   * @param {WorkspaceLeaf} leaf - The workspace leaf hosting this view
   * @param {LineChangeTrackerPlugin} plugin - The plugin instance, retained so
   *   the view can reach services through the DI container
   */
  public constructor(
    leaf: WorkspaceLeaf,
    protected plugin: LineChangeTrackerPlugin,
  ) {
    super(leaf);
  }

  /**
   * Resolves the view type id this view exposes. Convenience for the reveal
   * entry point (and tests) so callers do not have to import the constant.
   *
   * @return {string} The view type id
   */
  public static get viewType(): string {
    return VAULT_CHANGES_VIEW_TYPE;
  }

  /**
   * Returns the stable view type id used to register and look up the view.
   *
   * @return {string} The view type id
   * @override
   */
  public getViewType(): string {
    return VAULT_CHANGES_VIEW_TYPE;
  }

  /**
   * Returns the user-facing title rendered in the sidebar tab.
   *
   * @return {string} The localized display text
   * @override
   */
  public getDisplayText(): string {
    return this.plugin.t('view.vault-changes.title');
  }

  /**
   * Returns the Lucide icon id rendered in the sidebar tab. A file tree reads as
   * "changed files across the vault".
   *
   * @return {IconName} The Lucide icon id
   * @override
   */
  public getIcon(): IconName {
    return 'folder-git-2';
  }

  /**
   * Lifecycle hook called when Obsidian opens the view. Builds the header
   * (search + layout toggle), mounts the tree, subscribes to snapshot updates,
   * and renders the initial state. The subscription is torn down through the
   * Component `register` cleanup so a detach leaks nothing.
   *
   * @return {Promise<void>} Resolves once the host is prepared
   * @override
   */
  protected async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass('lct-vault-changes-view');

    this.buildHeader(this.contentEl);

    const listEl: HTMLElement = DomHelper.create({
      tag: 'div',
      classes: 'lct-vault-changes-list',
      container: this.contentEl,
    });

    this.tree.mount(listEl, (path: string): void => this.openPath(path), this.plugin);
    this.tree.setLayout(this.currentLayout());

    const onSnapshotUpdate = (): void => this.render();

    this.plugin.on(PluginEvent.snapshotsUpdate, onSnapshotUpdate, this);
    this.register((): void => {
      this.plugin.off(PluginEvent.snapshotsUpdate, onSnapshotUpdate, this);
    });

    this.render();
  }

  /**
   * Lifecycle hook called when Obsidian closes the view. Disposes the tree and
   * clears the content host so a re-open starts clean. Component lifetime handles
   * the registered event ref.
   *
   * @return {Promise<void>} Resolves once the host is cleared
   * @override
   */
  protected async onClose(): Promise<void> {
    this.tree.dispose();
    this.contentEl.empty();
    this.searchComponent = undefined;
    this.treeButton = undefined;
    this.flatButton = undefined;
  }

  /**
   * Builds the header row: a name-filter search box and the tree/flat layout
   * toggle. The search drives the tree's name filter; the toggle persists the
   * choice and re-lays out the list without rebuilding it.
   *
   * @param {HTMLElement} container - The content host to build the header into
   * @return {void}
   */
  protected buildHeader(container: HTMLElement): void {
    const header: HTMLElement = DomHelper.create({
      tag: 'div',
      classes: 'lct-vault-changes-header',
      container,
    });

    const searchEl: HTMLElement = DomHelper.create({
      tag: 'div',
      classes: 'lct-vault-changes-search',
      container: header,
    });

    this.searchComponent = new SearchComponent(searchEl)
      .setPlaceholder(this.plugin.t('view.vault-changes.search-placeholder'))
      .onChange((value: string): void => {
        this.tree.setNameFilter(value);
      });

    const toggle: HTMLElement = DomHelper.create({
      tag: 'div',
      classes: 'lct-vault-changes-layout-toggle',
      container: header,
    });

    this.treeButton = this.makeToggleButton(
      toggle,
      'folder-tree',
      this.plugin.t('view.vault-changes.layout.tree'),
      ChangesLayout.tree,
    );

    this.flatButton = this.makeToggleButton(
      toggle,
      'list',
      this.plugin.t('view.vault-changes.layout.flat'),
      ChangesLayout.flat,
    );

    this.updateToggleActive(this.currentLayout());
  }

  /**
   * Builds one layout-toggle icon button. Reuses Obsidian's `clickable-icon`
   * look; the active layout's button is marked with `is-active` (see
   * {@link updateToggleActive}). Clicking applies and persists the layout.
   *
   * @param {HTMLElement} container - The toggle group container
   * @param {IconName} icon - The Lucide icon id for the button
   * @param {string} label - The accessible label / tooltip
   * @param {ChangesLayout} layout - The layout this button selects
   * @return {HTMLElement} The created button element
   */
  protected makeToggleButton(
    container: HTMLElement,
    icon: IconName,
    label: string,
    layout: ChangesLayout,
  ): HTMLElement {
    const button: HTMLElement = DomHelper.create({
      tag: 'div',
      classes: ['clickable-icon', 'lct-vault-changes-layout-button'],
      attributes: { 'aria-label': label },
      events: {
        click: (): void => this.applyLayout(layout),
      },
      container,
    });

    setIcon(button, icon);

    return button;
  }

  /**
   * Applies and persists a layout choice, then re-lays out the list. A no-op
   * beyond the persist when the layout is unchanged (the tree component ignores
   * a same-layout call), so a redundant click is cheap.
   *
   * @param {ChangesLayout} layout - The layout to switch to
   * @return {void}
   */
  protected applyLayout(layout: ChangesLayout): void {
    this.settingsService().update('vaultChangesLayout', layout);
    this.tree.setLayout(layout);
    this.updateToggleActive(layout);
  }

  /**
   * Marks the active layout's toggle button and clears the other, so the header
   * reflects the current layout.
   *
   * @param {ChangesLayout} layout - The currently active layout
   * @return {void}
   */
  protected updateToggleActive(layout: ChangesLayout): void {
    this.treeButton?.classList.toggle('is-active', layout === ChangesLayout.tree);
    this.flatButton?.classList.toggle('is-active', layout === ChangesLayout.flat);
  }

  /**
   * Collects the vault-wide changed-file entries and hands them to the tree,
   * rooted at the vault root so every changed file shows. Excluded paths (our
   * own patterns and the plugin's own data dir) are filtered out so the panel
   * never lists a file the rest of the plugin ignores.
   *
   * @return {void}
   */
  protected render(): void {
    const snapshots: SnapshotsService = this.snapshotsService();
    const keep: KeepHistory = this.settingsService().value('keep');
    const entries: FolderTreeEntry[] = VaultChangesHelper.collectEntries(
      snapshots.getList(),
      (snapshot: FileSnapshot): string[] => resolveOrigin(snapshot, keep),
      (path: string): boolean => !snapshots.isPathExcluded(path),
    );

    this.tree.update({ entries, rootPath: '' });
  }

  /**
   * Opens the file at `path` in the active leaf. A deleted file (tombstone) has
   * no live file to open, so the panel reports an inline notice rather than
   * silently doing nothing.
   *
   * @param {string} path - The vault-relative path of the clicked file
   * @return {void}
   */
  protected openPath(path: string): void {
    const file: TFile | null = this.plugin.getFileByPath(path);

    if (!file) {
      new Notice(this.plugin.t('view.vault-changes.deleted-notice'));

      return;
    }

    void this.app.workspace.getLeaf(false).openFile(file);
  }

  /**
   * The persisted layout choice, defaulting through the settings default.
   *
   * @return {ChangesLayout} The current layout
   */
  protected currentLayout(): ChangesLayout {
    return this.settingsService().value('vaultChangesLayout');
  }

  /**
   * Resolves the snapshots service through the DI container.
   *
   * @return {SnapshotsService} The snapshots service
   */
  protected snapshotsService(): SnapshotsService {
    return this.plugin.get(TOKENS.snapshots);
  }

  /**
   * Resolves the settings service through the DI container.
   *
   * @return {SettingsService} The settings service
   */
  protected settingsService(): SettingsService {
    return this.plugin.get(TOKENS.settings);
  }
}
