import { FolderDeltaStatus } from '@/consts';
import type { FolderTreeEntry, FolderTreeNode } from '@/types';

/**
 * Pure, DOM-free tree model for the per-folder "changes since T" view.
 *
 * Extracted from {@link FolderTreeComponent} as a unit-testable object the
 * component instantiates and owns. It materialises the changed-file entries
 * into an in-memory node tree, owns that tree, and answers the structural
 * questions the renderer asks about it: which file is the natural default
 * selection, whether a previous selection still exists, and (as a stateless
 * predicate) whether a node survives the active name filter. The name filter
 * itself stays on the component: it is a view concern that never rebuilds the
 * tree, so it is passed to {@link nodeVisible} explicitly rather than owned
 * here.
 */
export class FolderTreeModel {
  /** The built tree's synthetic root, or null before the first {@link build}. */
  protected rootNode: FolderTreeNode | null = null;

  /**
   * Rebuilds the owned tree from a fresh `(entries, rootPath)` pair. The root
   * path is normalized here so callers can hand over the raw value. Entries
   * whose status is `'none'` and entries outside the root are dropped; the
   * result is the synthetic root whose children are the top-level rows.
   *
   * @param {FolderTreeEntry[]} entries - The changed-file entries to materialise
   * @param {string} rootPath - The raw root path (normalized internally)
   * @return {void}
   */
  public build(entries: FolderTreeEntry[], rootPath: string): void {
    this.rootNode = FolderTreeModel.buildTree(entries, FolderTreeModel.normalizeRoot(rootPath));
  }

  /**
   * Returns the current synthetic root node, or null before the first build.
   * The renderer walks its children to draw the tree.
   *
   * @return {FolderTreeNode | null} The synthetic root node or null
   */
  public getRoot(): FolderTreeNode | null {
    return this.rootNode;
  }

  /**
   * Whether the owned tree contains a file node with the given path. Used to
   * decide whether the previous selection survives a re-render.
   *
   * @param {string} path - The file path to look for
   * @return {boolean} True when a file node with that path exists
   */
  public containsFile(path: string): boolean {
    return FolderTreeModel.hasFile(this.rootNode, path);
  }

  /**
   * Returns the path of the first file in render order, or null when the tree
   * has no files. Used to seed the default selection so the diff pane is not
   * blank when changes exist.
   *
   * @return {string | null} The first file path or null
   */
  public firstFilePath(): string | null {
    return FolderTreeModel.firstFileUnder(this.rootNode);
  }

  /**
   * Drops the owned tree so a disposed component leaves no stale reference.
   *
   * @return {void}
   */
  public clear(): void {
    this.rootNode = null;
  }

  /**
   * Whether the node should render under the active name filter. A file matches
   * when its name contains the filter substring; a folder matches when any of
   * its descendant files match (so the ancestors of a hit stay visible). With
   * an empty filter every node is visible. The filter is a view concern owned
   * by the component, so it is passed in rather than read from model state.
   *
   * @param {FolderTreeNode} node - The node to test
   * @param {string} nameFilter - The lower-cased name filter (empty shows all)
   * @return {boolean} True when the node (or its subtree) survives the filter
   */
  public static nodeVisible(node: FolderTreeNode, nameFilter: string): boolean {
    if (!nameFilter) {
      return true;
    }

    if (!node.isFolder) {
      return node.name.toLowerCase().includes(nameFilter);
    }

    return node.children.some((child: FolderTreeNode): boolean => FolderTreeModel.nodeVisible(child, nameFilter));
  }

  /**
   * Normalizes a root path by trimming a trailing slash. The vault root is
   * passed as an empty string, which matches the prefix used everywhere else
   * in the plugin (see `FolderTimelineHelper`).
   *
   * @param {string} rootPath - The raw root path
   * @return {string} The normalized root path (no trailing slash)
   */
  protected static normalizeRoot(rootPath: string): string {
    if (!rootPath) {
      return '';
    }

    return rootPath.endsWith('/') ? rootPath.slice(0, -1) : rootPath;
  }

  /**
   * Builds an in-memory tree from the changed-file entries. Entries whose
   * status is `'none'` are skipped (only changed files render). Paths
   * outside the root are skipped too, matching `FolderTimelineHelper`'s prefix
   * semantics so the model is robust to a caller passing the whole map.
   *
   * @param {FolderTreeEntry[]} entries - The changed-file entries to materialise
   * @param {string} rootPath - The normalized root path
   * @return {FolderTreeNode} The synthetic root node (its children are the
   *   top-level entries of the tree, the root itself never renders).
   */
  protected static buildTree(entries: FolderTreeEntry[], rootPath: string): FolderTreeNode {
    const root: FolderTreeNode = {
      path: rootPath,
      name: '',
      isFolder: true,
      children: [],
    };

    const folderIndex: Map<string, FolderTreeNode> = new Map();

    folderIndex.set(rootPath, root);

    entries.forEach((entry: FolderTreeEntry): void => {
      if (!entry || typeof entry.path !== 'string') {
        return;
      }

      if (
        entry.status !== FolderDeltaStatus.added
        && entry.status !== FolderDeltaStatus.modified
        && entry.status !== FolderDeltaStatus.deleted
      ) {
        return;
      }

      if (!FolderTreeModel.isUnderRoot(entry.path, rootPath)) {
        return;
      }

      const relative: string = FolderTreeModel.relativeTo(entry.path, rootPath);
      const segments: string[] = relative.split('/').filter((segment: string): boolean => segment.length > 0);

      if (segments.length === 0) {
        return;
      }

      let parent: FolderTreeNode = root;
      let accumulatedRelative: string = '';

      // Walk every segment but the last to materialise the ancestor folders.
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

    FolderTreeModel.sortChildren(root);

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
  protected static isUnderRoot(path: string, rootPath: string): boolean {
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
  protected static relativeTo(path: string, rootPath: string): string {
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
  protected static sortChildren(node: FolderTreeNode): void {
    node.children.sort((a: FolderTreeNode, b: FolderTreeNode): number => {
      if (a.isFolder !== b.isFolder) {
        return a.isFolder ? -1 : 1;
      }

      return a.name.localeCompare(b.name);
    });

    node.children.forEach((child: FolderTreeNode): void => {
      if (child.isFolder) {
        FolderTreeModel.sortChildren(child);
      }
    });
  }

  /**
   * Whether the subtree under `node` contains the given file path.
   *
   * @param {FolderTreeNode | null} node - The node to search under
   * @param {string} path - The file path to look for
   * @return {boolean} True when a file node with that path exists
   */
  protected static hasFile(node: FolderTreeNode | null, path: string): boolean {
    if (!node) {
      return false;
    }

    if (!node.isFolder && node.path === path) {
      return true;
    }

    for (const child of node.children) {
      if (FolderTreeModel.hasFile(child, path)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Returns the path of the first file in render order under `node`, or null.
   *
   * @param {FolderTreeNode | null} node - The node to search under
   * @return {string | null} The first file path or null
   */
  protected static firstFileUnder(node: FolderTreeNode | null): string | null {
    if (!node) {
      return null;
    }

    for (const child of node.children) {
      if (!child.isFolder) {
        return child.path;
      }

      const nested: string | null = FolderTreeModel.firstFileUnder(child);

      if (nested) {
        return nested;
      }
    }

    return null;
  }
}
