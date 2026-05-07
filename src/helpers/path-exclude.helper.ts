/**
 * Pure helper that decides whether a vault file path is excluded from tracking
 * by a single, user-configured case-insensitive regular expression (D1). It
 * runs in addition to the extension filter: a file is tracked only when its
 * extension is allowed AND its path does NOT match the exclude pattern.
 *
 * The pattern is matched against the vault-relative path with forward slashes,
 * so a user can express any exclusion with full regexp power, for example:
 * - `\.excalidraw\.md$` to skip Excalidraw drawings anywhere,
 * - `(^|/)Templates/` to skip a Templates folder at any depth,
 * - `^Daily/` to skip a top-level Daily folder.
 *
 * Matching is case-insensitive (the `i` flag) to behave well on
 * case-insensitive file systems. An empty or whitespace-only pattern excludes
 * nothing. An invalid pattern (one that does not compile) is treated as
 * "exclude nothing" and never throws, so a typo cannot silently disable all
 * tracking; the caller is responsible for warning the user once.
 */
export class PathExcludeHelper {
  /**
   * Decides whether a file path is excluded by the given pattern. The path is
   * normalized to forward slashes before matching so a pattern written with
   * `/` works regardless of the host path separator. An empty pattern, an
   * empty path, or a pattern that fails to compile all return false (nothing
   * excluded).
   *
   * @param {string} path - The vault-relative file path to test
   * @param {string} pattern - The raw exclude pattern from the settings field
   * @return {boolean} True when the path matches the compiled pattern
   */
  public static isExcluded(path: string, pattern: string): boolean {
    if (!path) {
      return false;
    }

    const regExp: RegExp | null = PathExcludeHelper.compile(pattern);

    if (!regExp) {
      return false;
    }

    return regExp.test(PathExcludeHelper.normalize(path));
  }

  /**
   * Reports whether a pattern is usable: blank patterns are valid (they simply
   * exclude nothing), and a non-blank pattern is valid only when it compiles to
   * a regular expression. Callers use this to warn the user once about a
   * malformed pattern without coupling to the matching logic.
   *
   * @param {string} pattern - The raw exclude pattern from the settings field
   * @return {boolean} True when the pattern is blank or compiles successfully
   */
  public static isValid(pattern: string): boolean {
    if (!pattern || !pattern.trim()) {
      return true;
    }

    return PathExcludeHelper.compile(pattern) !== null;
  }

  /**
   * Safe-compiles the raw pattern into a case-insensitive regular expression.
   * A blank pattern yields null (matches nothing) and an invalid pattern is
   * caught and also yields null, so compilation never throws.
   *
   * @param {string} pattern - The raw exclude pattern from the settings field
   * @return {RegExp|null} The compiled regex, or null when blank or invalid
   */
  protected static compile(pattern: string): RegExp | null {
    if (!pattern || !pattern.trim()) {
      return null;
    }

    try {
      return new RegExp(pattern.trim(), 'i');
    } catch {
      return null;
    }
  }

  /**
   * Normalizes a path for matching: converts backslashes to forward slashes and
   * drops a leading `./` or `/` so the value aligns with the vault-relative
   * paths the user writes patterns against.
   *
   * @param {string} value - The raw path
   * @return {string} The normalized path
   */
  protected static normalize(value: string): string {
    let result: string = value.replace(/\\/g, '/');

    if (result.startsWith('./')) {
      result = result.slice(2);
    }

    if (result.startsWith('/')) {
      result = result.slice(1);
    }

    return result;
  }
}
