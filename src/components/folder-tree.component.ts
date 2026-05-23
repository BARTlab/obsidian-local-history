import { FolderDeltaStatus } from '@/consts';
import { DomHelper } from '@/helpers/dom.helper';
import type {
  DomElementConfig,
  FolderTreeNode,
  FolderTreeSelectionHandler,
  TranslationVars,
} from '@/types';
import { isString } from 'lodash-es';
import { setIcon } from 'obsidian';

/**
 * One entry handed to {@link FolderTreeComponent.update}: a vault-relative file
 * path and the per-file delta status resolved by `FolderDeltaHelper.compareAt`
 * for the selected timeline point T.
 *
 * The component only renders rows whose status is `added | modified | deleted`
 * (D9). Entries with status `'none'` are accepted to keep the call-site simple
 * (the caller can pass every snapshot in the subtree) but are filtered out
 * before rendering so the tree shows only the files that actually changed.
 */
export interface FolderTreeEntry {
  path: string;
  status: FolderDeltaStatus;
  /**
   * Optional flag set when the file's latest delta point at the picked T is an
   * external-change capture (D13, T20). The component renders a small badge on
   * the file row when true so the user can spot external states without
   * leaving the tree (AC3). The field is optional so unit tests and earlier
   * callers can keep ignoring it; the rendered tree only depends on it for the
   * badge, not for the row's visibility or its status colour token.
   */
  external?: boolean;
}

/**
 * Minimal translator surface the component needs. Matches `LineChangeTrackerPlugin.t`
 * so the modal can pass `plugin` directly, but stays narrow so unit tests can
 * supply an inert translator (echoing keys) without the real plugin instance.
 */
export interface FolderTreeTranslator {
  t(key: string, vars?: TranslationVars): string;
}

/**
 * Parameters for {@link FolderTreeComponent.update}. The component fully owns
 * the DOM under its mount container, so update is the single entry point that
 * rebuilds the tree against a fresh `(entries, rootPath)` pair while keeping
 * the user's expand/collapse state and the currently-selected file (when it is
 * still present in the new entries).
 */
export interface FolderTreeUpdateParams {
  entries: FolderTreeEntry[];
  rootPath: string;
}

/**
 * Component that renders the per-folder "changes since T" tree shown in the
 * middle column of `FolderHistoryModal` (D9, D10). The component is mount /
 * update / dispose lifecycle-driven so the parent modal can re-render the tree
 * on every timeline-point pick without recreating the component (which would
 * otherwise drop the expand/collapse state the user just set).
 *
 * Rendering rules (D9):
 * - Only files whose status from `FolderDeltaHelper.compareAt` is one of
 *   `added | modified | deleted` are shown. Other entries are dropped silently
 *   so the call-site can hand over every snapshot in the subtree without
 *   pre-filtering.
 * - Ancestor folders are included only when they are needed to keep a changed
 *   file connected to the root. Unchanged sibling folders never render.
 * - The root itself never renders as a row (the modal already labels the
 *   column with the root folder's name); its children are rendered directly
 *   at the top level of the tree.
 *
 * Interaction rules (AC3 / AC4):
 * - Clicking a file row emits the path via the selection handler and marks
 *   the row with `is-active`. Re-rendering preserves the selection when the
 *   same path is still in the tree; otherwise the first file in render order
 *   becomes the selection so the diff pane never goes blank with rows visible.
 * - Clicking a folder row toggles its expansion. Expanded paths live in an
 *   instance-scoped `Set<string>` keyed by full path so the state survives
 *   `update` calls until the component is disposed.
 *
 * Initial state: every folder starts expanded so a fresh open shows every
 * changed file at once. The user collapses folders to focus, and the choice
 * is remembered within the modal lifetime.
 */
export class FolderTreeComponent {
  /**
   * Container the component renders into; null between dispose / re-mount.
   */
  protected container: HTMLElement | null = null;

  /**
   * Last computed root from {@link update}, used to normalize child paths.
   */
  protected rootPath: string = '';

  /**
   * Last computed root node, retained so re-renders do not need re-input.
   */
  protected rootNode: FolderTreeNode | null = null;

  /**
   * Currently-selected file path, or null when nothing is selected yet.
   */
  protected selectedPath: string | null = null;

  /**
   * Collapsed folder paths; absence in this set means "expanded" (initial).
   */
  protected collapsedFolders: Set<string> = new Set<string>();

  /**
   * Case-insensitive substring filter applied to file names at render time.
   * Empty shows the whole tree. A view-only concern: it never rebuilds the
   * node tree (so it survives across timeline picks) and does not touch the
   * selection. When active, every folder is force-expanded so matches deep in
   * a collapsed branch are still revealed.
   */
  protected nameFilter: string = '';

  /**
   * Selection callback wired by the parent modal; no-op until set.
   */
  protected onSelect: FolderTreeSelectionHandler | null = null;

  /**
   * Translator used for the empty-state hint; echoes keys when unset.
   */
  protected plugin: FolderTreeTranslator | null = null;

  /**
   * Mounts the component into the given container. The component takes full
   * ownership of the container's contents on each {@link update} call, so the
   * caller must not append siblings into the same node.
   *
   * @param {HTMLElement} container - The host element the tree renders into
   * @param {FolderTreeSelectionHandler} onSelect - Selection callback for file rows
   * @param {FolderTreeTranslator} [plugin] - Optional translator; defaults to echo
   * @return {void}
   */
  public mount(
    container: HTMLElement,
    onSelect: FolderTreeSelectionHandler,
    plugin?: FolderTreeTranslator,
  ): void {
    this.container = container;
    this.onSelect = onSelect;
    this.plugin = plugin ?? null;
  }

  /**
   * Rebuilds the tree from the new `(entries, rootPath)` pair. The previous
   * expand/collapse map is preserved by folder path; the previous selection
   * is preserved when the file is still in the new tree, otherwise it falls
   * back to the first file in render order so the diff pane has a sensible
   * default to render.
   *
   * @param {FolderTreeUpdateParams} params - The new entries and root path
   * @return {void}
   */
  public update(params: FolderTreeUpdateParams): void {
    if (!this.container) {
      return;
    }

    this.rootPath = this.normalizeRoot(params.rootPath);
    this.rootNode = this.build(params.entries, this.rootPath);

    /**
     * Reset selection when the previous file is no longer present so the diff
     * pane never points at a row that does not exist anymore. The first file
     * in render order is the natural fallback; AC3 of T12 also defaults to it.
     */
    if (this.selectedPath !== null && !this.containsFile(this.rootNode, this.selectedPath)) {
      this.selectedPath = null;
    }

    if (this.selectedPath === null) {
      this.selectedPath = this.firstFilePath(this.rootNode);
    }

    this.render();
  }

  /**
   * Returns the currently-selected file path, or null when nothing has been
   * selected yet (empty tree, or update has never been called).
   *
   * @return {string | null} The selected file path
   */
  public getSelectedPath(): string | null {
    return this.selectedPath;
  }

  /**
   * Sets the case-insensitive file-name filter and re-renders. A no-op when the
   * normalized query is unchanged so repeated keystrokes that collapse to the
   * same value do not thrash the DOM.
   *
   * @param {string} query - The raw filter query
   * @return {void}
   */
  public setNameFilter(query: string): void {
    const normalized: string = (query ?? '').trim().toLowerCase();

    if (normalized === this.nameFilter) {
      return;
    }

    this.nameFilter = normalized;
    this.render();
  }

  /**
   * Tears the component down: drops references and clears the container so
   * the modal can dispose without leaving stale DOM. The expand/collapse map
   * is cleared too, which is the documented lifetime boundary (AC4).
   *
   * @return {void}
   */
  public dispose(): void {
    if (this.container) {
      this.container.empty();
    }

    this.container = null;
    this.rootNode = null;
    this.selectedPath = null;
    this.collapsedFolders.clear();
    this.nameFilter = '';
    this.onSelect = null;
    this.plugin = null;
  }

  /**
   * Normalizes a root path by trimming a trailing slash. The vault root is
   * passed as an empty string, which matches the prefix used everywhere else
   * in the plugin (see `FolderTimelineHelper`).
   *
   * @param {string} rootPath - The raw root path
   * @return {string} The normalized root path (no trailing slash)
   */
  protected normalizeRoot(rootPath: string): string {
    if (!rootPath) {
      return '';
    }

    return rootPath.endsWith('/') ? rootPath.slice(0, -1) : rootPath;
  }

  /**
   * Builds an in-memory tree from the changed-file entries. Entries whose
   * status is `'none'` are skipped (D9: only changed files render). Paths
   * outside the root are skipped too, matching `FolderTimelineHelper`'s prefix
   * semantics so the component is robust to a caller passing the whole map.
   *
   * @param {FolderTreeEntry[]} entries - The changed-file entries to materialise
   * @param {string} rootPath - The normalized root path
   * @return {FolderTreeNode} The synthetic root node (its children are the
   *   top-level entries of the tree, the root itself never renders).
   */
  protected build(entries: FolderTreeEntry[], rootPath: string): FolderTreeNode {
    const root: FolderTreeNode = {
      path: rootPath,
      name: '',
      isFolder: true,
      children: [],
    };

    const folderIndex: Map<string, FolderTreeNode> = new Map<string, FolderTreeNode>();

    folderIndex.set(rootPath, root);

    entries.forEach((entry: FolderTreeEntry): void => {
      if (!entry || !isString(entry.path)) {
        return;
      }

      if (
        entry.status !== FolderDeltaStatus.added
        && entry.status !== FolderDeltaStatus.modified
        && entry.status !== FolderDeltaStatus.deleted
      ) {
        return;
      }

      if (!this.isUnderRoot(entry.path, rootPath)) {
        return;
      }

      const relative: string = this.relativeTo(entry.path, rootPath);
      const segments: string[] = relative.split('/').filter((segment: string): boolean => segment.length > 0);

      if (segments.length === 0) {
        return;
      }

      let parent: FolderTreeNode = root;
      let accumulatedRelative: string = '';

      /**
       * Walk every segment but the last to materialise the ancestor folders.
       */
      for (let i: number = 0; i < segments.length - 1; i += 1) {
        const segment: string = segments[i];

        accumulatedRelative = accumulatedRelative ? `${accumulatedRelative}/${segment}` : segment;

        const folderPath: string = rootPath ? `${rootPath}/${accumulatedRelative}` : accumulatedRelative;
        let folder: FolderTreeNode | undefined = folderIndex.get(folderPath);

        if (!folder) {
          folder = {
            path: folderPath,
            name: segment,
            isFolder: true,
            children: [],
          };

          parent.children.push(folder);
          folderIndex.set(folderPath, folder);
        }

        parent = folder;
      }

      const fileName: string = segments[segments.length - 1];

      parent.children.push({
        path: entry.path,
        name: fileName,
        isFolder: false,
        status: entry.status,
        external: entry.external === true,
        children: [],
      });
    });

    this.sortChildren(root);

    return root;
  }

  /**
   * Whether the given path lies under the root (`path === root` is excluded
   * because the root itself is a folder, not a file we render). Mirrors the
   * prefix check in `FolderTimelineHelper` so behaviour is consistent across
   * the folder-modal surfaces.
   *
   * @param {string} path - The candidate vault-relative path
   * @param {string} rootPath - The normalized root path
   * @return {boolean} True when `path` is strictly under `rootPath`
   */
  protected isUnderRoot(path: string, rootPath: string): boolean {
    if (!rootPath) {
      return path.length > 0;
    }

    return path.startsWith(`${rootPath}/`);
  }

  /**
   * Returns the portion of `path` relative to `rootPath`. The vault root
   * (empty `rootPath`) returns `path` as-is.
   *
   * @param {string} path - The vault-relative file path
   * @param {string} rootPath - The normalized root path
   * @return {string} The path stripped of the root prefix
   */
  protected relativeTo(path: string, rootPath: string): string {
    if (!rootPath) {
      return path;
    }

    return path.slice(rootPath.length + 1);
  }

  /**
   * Sorts a node's children recursively: folders before files, then by name
   * alphabetically. The order is stable so two equal inputs render identically.
   *
   * @param {FolderTreeNode} node - The node whose children to sort
   * @return {void}
   */
  protected sortChildren(node: FolderTreeNode): void {
    node.children.sort((a: FolderTreeNode, b: FolderTreeNode): number => {
      if (a.isFolder !== b.isFolder) {
        return a.isFolder ? -1 : 1;
      }

      return a.name.localeCompare(b.name);
    });

    node.children.forEach((child: FolderTreeNode): void => {
      if (child.isFolder) {
        this.sortChildren(child);
      }
    });
  }

  /**
   * Whether the tree contains the given file path. Used to decide whether the
   * previous selection survives a re-render.
   *
   * @param {FolderTreeNode} node - The root node to search under
   * @param {string} path - The file path to look for
   * @return {boolean} True when a file node with that path exists
   */
  protected containsFile(node: FolderTreeNode | null, path: string): boolean {
    if (!node) {
      return false;
    }

    if (!node.isFolder && node.path === path) {
      return true;
    }

    for (const child of node.children) {
      if (this.containsFile(child, path)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Returns the path of the first file in render order, or null when the tree
   * has no files. Used to seed the default selection so the diff pane is not
   * blank when changes exist.
   *
   * @param {FolderTreeNode} node - The root node
   * @return {string | null} The first file path or null
   */
  protected firstFilePath(node: FolderTreeNode | null): string | null {
    if (!node) {
      return null;
    }

    for (const child of node.children) {
      if (!child.isFolder) {
        return child.path;
      }

      const nested: string | null = this.firstFilePath(child);

      if (nested) {
        return nested;
      }
    }

    return null;
  }

  /**
   * Renders the current tree state into the mounted container. The container
   * is fully replaced on every render; the persistent state (selection, the
   * collapsed-folders set) survives across renders because it lives on the
   * component instance.
   *
   * @return {void}
   */
  protected render(): void {
    if (!this.container) {
      return;
    }

    this.container.empty();

    const visibleChildren: FolderTreeNode[] = this.rootNode
      ? this.rootNode.children.filter((child: FolderTreeNode): boolean => this.nodeVisible(child))
      : [];

    if (visibleChildren.length === 0) {
      this.renderEmpty(this.container);

      return;
    }

    const list: HTMLElement = DomHelper.create({
      tag: 'div',
      classes: 'lct-folder-tree',
      container: this.container,
    });

    visibleChildren.forEach((child: FolderTreeNode): void => {
      this.renderNode(list, child, 0);
    });
  }

  /**
   * Whether the node should render under the active name filter. A file matches
   * when its name contains the filter substring; a folder matches when any of
   * its descendant files match (so the ancestors of a hit stay visible). With
   * an empty filter every node is visible.
   *
   * @param {FolderTreeNode} node - The node to test
   * @return {boolean} True when the node (or its subtree) survives the filter
   */
  protected nodeVisible(node: FolderTreeNode): boolean {
    if (!this.nameFilter) {
      return true;
    }

    if (!node.isFolder) {
      return node.name.toLowerCase().includes(this.nameFilter);
    }

    return node.children.some((child: FolderTreeNode): boolean => this.nodeVisible(child));
  }

  /**
   * Renders the empty-state hint when the tree contains no changed files. The
   * text flows through `plugin.t('folder-tree.empty')` so every bundled catalog
   * carries it (T15). Unit tests that mount the component without a translator
   * see the bare key (the inert translator path), which is acceptable for an
   * assertion that the empty branch was rendered.
   *
   * @param {HTMLElement} container - The host container to render into
   * @return {void}
   */
  protected renderEmpty(container: HTMLElement): void {
    const fallback: string = 'No changes in this folder for the selected point.';
    const resolved: string | null = this.plugin ? this.plugin.t('folder-tree.empty') : null;
    /**
     * The catalog is the source of truth, but unit tests mount the component
     * without a translator; fall back to the English literal so the empty
     * branch renders a human-readable hint in either path.
     */
    const text: string = resolved && resolved !== 'folder-tree.empty' ? resolved : fallback;

    DomHelper.create({
      tag: 'div',
      classes: 'lct-folder-tree-empty',
      text,
      container,
    });
  }

  /**
   * Renders a single node (folder or file) and recurses into the children of
   * an expanded folder. Indentation is implicit in nesting: each row carries
   * a depth-based padding via inline style so the renderer does not have to
   * spawn intermediate wrapper levels per depth.
   *
   * @param {HTMLElement} container - The host container for this node
   * @param {FolderTreeNode} node - The node to render
   * @param {number} depth - The depth from the visible root (0 for top-level)
   * @return {void}
   */
  protected renderNode(container: HTMLElement, node: FolderTreeNode, depth: number): void {
    if (node.isFolder) {
      this.renderFolder(container, node, depth);
    } else {
      this.renderFile(container, node, depth);
    }
  }

  /**
   * Renders a folder row plus, when the folder is expanded, its children.
   * Clicking the row toggles the folder's collapsed state and triggers a
   * re-render so the chevron and the children are kept in sync.
   *
   * @param {HTMLElement} container - The host container
   * @param {FolderTreeNode} node - The folder node
   * @param {number} depth - The depth from the visible root
   * @return {void}
   */
  protected renderFolder(container: HTMLElement, node: FolderTreeNode, depth: number): void {
    /**
     * While a name filter is active, force every folder open so matches that
     * live in an otherwise-collapsed branch are still revealed. The user's
     * collapse choices are preserved (the set is untouched) and re-applied
     * once the filter is cleared.
     */
    const isCollapsed: boolean = this.nameFilter ? false : this.collapsedFolders.has(node.path);

    const row: HTMLElement = DomHelper.create({
      tag: 'div',
      classes: ['lct-folder-tree-row', 'lct-folder-tree-folder'],
      attributes: { 'data-path': node.path },
      styles: { paddingInlineStart: `calc(var(--size-4-2) + ${depth * 16}px)` },
      events: {
        click: (event: Event): void => {
          event.preventDefault();
          this.toggleFolder(node.path);
        },
      },
      container,
    });

    const chevron: HTMLElement = DomHelper.create({
      tag: 'span',
      classes: 'lct-folder-tree-chevron',
      container: row,
    });

    setIcon(chevron, isCollapsed ? 'chevron-right' : 'chevron-down');

    const icon: HTMLElement = DomHelper.create({
      tag: 'span',
      classes: 'lct-folder-tree-icon',
      container: row,
    });

    setIcon(icon, 'folder');

    DomHelper.create({
      tag: 'span',
      classes: 'lct-folder-tree-name',
      text: node.name,
      container: row,
    });

    if (!isCollapsed) {
      node.children.forEach((child: FolderTreeNode): void => {
        if (this.nodeVisible(child)) {
          this.renderNode(container, child, depth + 1);
        }
      });
    }
  }

  /**
   * Renders a file row coloured by its delta status. The row gets the
   * `is-active` class when its path matches the current selection so the
   * caller's CSS can style the active row without re-querying the DOM. The
   * click handler emits the path and marks the row active without recomputing
   * the whole tree, which keeps selection-only updates cheap.
   *
   * @param {HTMLElement} container - The host container
   * @param {FolderTreeNode} node - The file node
   * @param {number} depth - The depth from the visible root
   * @return {void}
   */
  protected renderFile(container: HTMLElement, node: FolderTreeNode, depth: number): void {
    const statusClass: string = this.statusClassName(node.status);
    const classes: string[] = ['lct-folder-tree-row', 'lct-folder-tree-file', statusClass];

    if (this.selectedPath === node.path) {
      classes.push('is-active');
    }

    const config: DomElementConfig = {
      tag: 'div',
      classes,
      attributes: { 'data-path': node.path },
      styles: { paddingInlineStart: `calc(var(--size-4-2) + ${depth * 16}px)` },
      events: {
        click: (event: Event): void => {
          event.preventDefault();
          this.selectFile(node.path);
        },
      },
      container,
    };

    const row: HTMLElement = DomHelper.create(config);

    const icon: HTMLElement = DomHelper.create({
      tag: 'span',
      classes: 'lct-folder-tree-icon',
      container: row,
    });

    setIcon(icon, 'file');

    DomHelper.create({
      tag: 'span',
      classes: 'lct-folder-tree-name',
      text: node.name,
      container: row,
    });

    if (node.external) {
      this.renderExternalBadge(row);
    }
  }

  /**
   * Renders the inline external-change badge on a file row (D13, T20): a
   * Lucide `download-cloud` glyph plus a short text label, marked with an
   * `aria-label` so assistive tech announces the badge. The text is an inline
   * English literal here and is propagated to every catalog in T15 (D13
   * pattern); until then it shows in English on every locale even when the
   * translator is wired, matching the rest of the folder modal's inline
   * literals (see FolderHistoryModal.kindLabel).
   *
   * @param {HTMLElement} row - The file row to append the badge to
   * @return {void}
   */
  protected renderExternalBadge(row: HTMLElement): void {
    const fallback: string = 'external';
    const resolved: string | null = this.plugin ? this.plugin.t('version.badge.external') : null;
    /**
     * Same translator-fallback contract as renderEmpty: unit tests can mount
     * the component without a translator and still see the English literal.
     */
    const text: string = resolved && resolved !== 'version.badge.external' ? resolved : fallback;

    const badge: HTMLElement = DomHelper.create({
      tag: 'span',
      classes: 'lct-version-external-badge',
      attributes: { 'aria-label': text, 'title': text },
      container: row,
    });

    const slot: HTMLElement = DomHelper.create({
      tag: 'span',
      classes: 'lct-version-external-badge-icon',
      container: badge,
    });

    setIcon(slot, 'download-cloud');

    DomHelper.create({
      tag: 'span',
      classes: 'lct-version-external-badge-text',
      text,
      container: badge,
    });
  }

  /**
   * Maps the delta status to its row class. The three statuses are stable
   * tokens the modal CSS hooks into (T14); rows with status `'none'` never
   * reach this code path because they are filtered in {@link build}.
   *
   * @param {FolderDeltaStatus} status - The per-file delta status
   * @return {string} The CSS class for the row's colour token
   */
  protected statusClassName(status: FolderDeltaStatus | undefined): string {
    if (status === FolderDeltaStatus.added) {
      return 'lct-tree-added';
    }

    if (status === FolderDeltaStatus.deleted) {
      return 'lct-tree-deleted';
    }

    return 'lct-tree-modified';
  }

  /**
   * Toggles a folder's collapsed state and re-renders. The set stores
   * collapsed paths (not expanded ones) so an unknown folder defaults to
   * expanded: a fresh tree shows every changed file without an extra click.
   *
   * @param {string} folderPath - The folder's vault-relative path
   * @return {void}
   */
  protected toggleFolder(folderPath: string): void {
    if (this.collapsedFolders.has(folderPath)) {
      this.collapsedFolders.delete(folderPath);
    } else {
      this.collapsedFolders.add(folderPath);
    }

    this.render();
  }

  /**
   * Marks `path` as the active file and notifies the parent. The render is
   * full (not incremental) because re-running it keeps every row's
   * `is-active` class consistent without bespoke DOM queries; the tree's
   * structure does not change so the cost is bounded.
   *
   * @param {string} path - The file's vault-relative path
   * @return {void}
   */
  protected selectFile(path: string): void {
    this.selectedPath = path;
    this.render();

    if (this.onSelect) {
      this.onSelect(path);
    }
  }
}
