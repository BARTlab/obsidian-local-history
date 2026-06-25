import type { ListedFiles } from 'obsidian';

/**
 * One recorded adapter call: the operation name plus the path arguments it was
 * invoked with. Tests assert on this log to prove write ordering (atomic
 * `tmp -> bak -> rename`), dirty-only granularity, and reconciliation IO.
 */
export interface AdapterCall {
  readonly op: 'write' | 'rename' | 'remove' | 'exists' | 'read' | 'mkdir' | 'rmdir' | 'list';
  readonly args: readonly string[];
}

/**
 * In-memory stand-in for Obsidian's `DataAdapter`, shared between the shard
 * store unit tests and the ported persistence tests. It
 * models a flat `Map<path, contents>` for files and a separate set of explicit
 * directory paths, deriving `list` from the flat map by path prefix so the
 * directory enumeration the shard store relies on (the source of truth, ADR-10)
 * behaves like the real adapter without a real filesystem.
 *
 * The original inline fake in the persistence suite modelled only
 * `write/read/exists/rename/remove`; this promotes it to a shared stub and adds
 * the directory surface (`mkdir`, `rmdir`, `list`) the shard store needs, while
 * keeping `files`, `calls`, `writeDelay`, and `failNextRename` so existing
 * behaviour (the write queue, the rename-failure path) is preserved verbatim.
 */
export class MemoryAdapter {
  /**
   * The flat file map: vault-relative path to serialized contents.
   */
  public files: Map<string, string> = new Map<string, string>();

  /**
   * The set of explicitly created directory paths. A directory also exists
   * implicitly while it holds files, but `mkdir` records it here so an empty
   * directory still reports as present, matching the real adapter.
   */
  public dirs: Set<string> = new Set<string>();

  /**
   * Ordered log of every call, for assertions on IO shape and ordering.
   */
  public calls: AdapterCall[] = [];

  /**
   * Optional artificial delay (ms) injected into `write`, used to exercise the
   * service's write-queue serialization without real disk latency.
   */
  public writeDelay: number = 0;

  /**
   * When set, the next `rename` throws once and resets, simulating a crash
   * between the atomic write's rename steps.
   */
  public failNextRename: boolean = false;

  /**
   * Reports whether a path is a known file or directory. A directory is present
   * when it was explicitly created or when any file lives under it, so the
   * shard store's `exists(dir)` guards behave like the real adapter.
   *
   * @param {string} path - The path to test.
   * @return {Promise<boolean>} True when the path is a file or directory.
   */
  public async exists(path: string): Promise<boolean> {
    this.calls.push({ op: 'exists', args: [path] });

    return this.files.has(path) || this.isDir(path);
  }

  /**
   * Reads a file's contents, throwing when it is absent (mirroring the real
   * adapter, which rejects on a missing file).
   *
   * @param {string} path - The file path to read.
   * @return {Promise<string>} The stored contents.
   */
  public async read(path: string): Promise<string> {
    this.calls.push({ op: 'read', args: [path] });

    const value: string | undefined = this.files.get(path);

    if (value === undefined) {
      throw new Error(`MemoryAdapter: missing ${path}`);
    }

    return value;
  }

  /**
   * Writes a file's contents, honouring the optional `writeDelay` so a test can
   * drive concurrent enqueues through the service's write queue.
   *
   * @param {string} path - The file path to write.
   * @param {string} data - The contents to store.
   * @return {Promise<void>} Resolves once the file is stored.
   */
  public async write(path: string, data: string): Promise<void> {
    this.calls.push({ op: 'write', args: [path] });

    if (this.writeDelay > 0) {
      await new Promise<void>((resolve: () => void): void => {
        setTimeout(resolve, this.writeDelay);
      });
    }

    this.files.set(path, data);
  }

  /**
   * Moves a file, throwing once if `failNextRename` is armed (to simulate a
   * crash mid-write) or when the source is absent (matching the real adapter).
   *
   * @param {string} from - The source path.
   * @param {string} to - The destination path.
   * @return {Promise<void>} Resolves once the move completes.
   */
  public async rename(from: string, to: string): Promise<void> {
    this.calls.push({ op: 'rename', args: [from, to] });

    if (this.failNextRename) {
      this.failNextRename = false;
      throw new Error('MemoryAdapter: rename failed');
    }

    const value: string | undefined = this.files.get(from);

    if (value === undefined) {
      throw new Error(`MemoryAdapter: cannot rename missing ${from}`);
    }

    this.files.set(to, value);
    this.files.delete(from);
  }

  /**
   * Removes a file. Idempotent: removing an absent file is a no-op, matching the
   * shard store's best-effort cleanup expectations.
   *
   * @param {string} path - The file path to remove.
   * @return {Promise<void>} Resolves once the file is gone.
   */
  public async remove(path: string): Promise<void> {
    this.calls.push({ op: 'remove', args: [path] });
    this.files.delete(path);
  }

  /**
   * Records a directory as created. Like the real adapter, an existing
   * directory is left untouched (the store swallows any error regardless).
   *
   * @param {string} path - The directory path to create.
   * @return {Promise<void>} Resolves once the directory is recorded.
   */
  public async mkdir(path: string): Promise<void> {
    this.calls.push({ op: 'mkdir', args: [path] });
    this.dirs.add(path);
  }

  /**
   * Removes a directory. With `recursive` true, every file beneath it (by path
   * prefix) and the directory record itself are dropped, mirroring the real
   * adapter's recursive `rmdir` that the store uses to wipe history on disable.
   *
   * @param {string} path - The directory path to remove.
   * @param {boolean} recursive - Whether to delete contained files and subdirs.
   * @return {Promise<void>} Resolves once the directory is gone.
   */
  public async rmdir(path: string, recursive: boolean): Promise<void> {
    this.calls.push({ op: 'rmdir', args: [path, String(recursive)] });

    if (recursive) {
      const prefix: string = `${path}/`;

      for (const file of [...this.files.keys()]) {
        if (file.startsWith(prefix)) {
          this.files.delete(file);
        }
      }

      for (const dir of [...this.dirs]) {
        if (dir === path || dir.startsWith(prefix)) {
          this.dirs.delete(dir);
        }
      }

      return;
    }

    this.dirs.delete(path);
  }

  /**
   * Lists the immediate children of a directory, derived from the flat map by
   * path prefix: `files` holds full vault-relative paths of files directly under
   * `path`, `folders` the immediate subdirectory paths. Nested files contribute
   * their first path segment as a folder, matching the real adapter's
   * single-level listing.
   *
   * @param {string} path - The directory path to enumerate.
   * @return {Promise<ListedFiles>} The immediate files and folders.
   */
  public async list(path: string): Promise<ListedFiles> {
    this.calls.push({ op: 'list', args: [path] });

    const prefix: string = `${path}/`;
    const files: string[] = [];
    const folders: Set<string> = new Set<string>();

    for (const file of this.files.keys()) {
      if (!file.startsWith(prefix)) {
        continue;
      }

      const rest: string = file.slice(prefix.length);
      const slash: number = rest.indexOf('/');

      if (slash === -1) {
        files.push(file);
      } else {
        folders.add(`${prefix}${rest.slice(0, slash)}`);
      }
    }

    for (const dir of this.dirs) {
      if (dir.startsWith(prefix) && dir.slice(prefix.length).indexOf('/') === -1) {
        folders.add(dir);
      }
    }

    return { files, folders: [...folders] };
  }

  /**
   * Whether a path is a directory: explicitly created, or the parent of any
   * stored file.
   *
   * @param {string} path - The path to test.
   * @return {boolean} True when the path is a known directory.
   */
  protected isDir(path: string): boolean {
    if (this.dirs.has(path)) {
      return true;
    }

    const prefix: string = `${path}/`;

    for (const file of this.files.keys()) {
      if (file.startsWith(prefix)) {
        return true;
      }
    }

    return false;
  }
}
