/**
 * Pure helper for vault-path string operations the snapshot service needs. The
 * vault stores paths as forward-slash strings (Obsidian normalises them to
 * POSIX-style regardless of host OS), so this helper deliberately does not
 * touch backslashes: callers feed it the same path strings the vault hands out.
 *
 * Kept stateless and dependency-free so it can be reused across the codebase
 * (move detection in SnapshotsService.markMoved, folder-prefix matching for
 * the folder modal, future path checks) without dragging in Obsidian types.
 */
export class PathHelper {
  /**
   * Returns the directory portion of a vault-relative path, without a trailing
   * slash. A path with no slash (a file at the vault root) returns an empty
   * string; an empty input returns an empty string too. The semantics mirror
   * Node's `path.posix.dirname` for the cases this codebase uses, but stay
   * inside a small explicit contract so a future change cannot drift.
   *
   * Examples:
   * - `dirname('src/a.md')` returns `'src'`
   * - `dirname('a.md')` returns `''`
   * - `dirname('')` returns `''`
   * - `dirname('a/b/c.md')` returns `'a/b'`
   *
   * @param {string} path - The vault-relative path
   * @return {string} The directory portion, or an empty string for the root
   */
  public static dirname(path: string): string {
    if (!path) {
      return '';
    }

    const lastSlash: number = path.lastIndexOf('/');

    if (lastSlash <= 0) {
      return '';
    }

    return path.slice(0, lastSlash);
  }
}
