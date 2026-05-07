/**
 * Pure helper that decides whether a vault file path is excluded from tracking
 * by a user-configured list of path/glob patterns (T5.6). It runs in addition
 * to the extension filter: a file is tracked only when its extension is allowed
 * AND its path matches none of the exclude patterns.
 *
 * Matching is intentionally self-contained (no glob dependency) and supports a
 * small, predictable syntax against vault-relative paths with forward slashes:
 * - `*` matches any run of characters except a slash (one path segment),
 * - `**` matches any run of characters including slashes (crosses folders),
 * - `?` matches exactly one character except a slash,
 * - a pattern with no glob character is treated as a folder/file prefix, so
 *   `templates` or `templates/` excludes everything under `templates/` (and the
 *   `templates` entry itself), matching the common "ignore this folder" intent.
 *
 * Matching is case-insensitive to stay consistent with the extension filter and
 * to behave well on case-insensitive file systems. An empty pattern list (or a
 * list of only blank entries) excludes nothing.
 */
export class PathExcludeHelper {
  /**
   * Characters that mark a pattern as a glob rather than a plain prefix.
   */
  protected static readonly GLOB_CHARS: RegExp = /[*?]/;

  /**
   * Parses a raw, comma- or newline-separated pattern string into a clean list
   * of patterns: trimmed, blank entries dropped, backslashes normalized to
   * forward slashes, and any leading `./` or `/` stripped so patterns align
   * with vault-relative paths.
   *
   * @param {string} raw - The raw pattern text from the settings field
   * @return {string[]} The normalized, non-empty pattern list
   */
  public static parse(raw: string): string[] {
    if (!raw) {
      return [];
    }

    return raw
      .split(/[\n,]/)
      .map((pattern: string): string => PathExcludeHelper.normalize(pattern))
      .filter((pattern: string): boolean => pattern.length > 0);
  }

  /**
   * Decides whether a file path is excluded by any of the given patterns.
   * The path is normalized the same way patterns are (forward slashes, no
   * leading `./` or `/`) so comparisons are apples to apples. An empty or
   * all-blank pattern list excludes nothing.
   *
   * @param {string} path - The vault-relative file path to test
   * @param {string[]} patterns - The exclude patterns (already split per entry)
   * @return {boolean} True when the path matches at least one pattern
   */
  public static isExcluded(path: string, patterns: string[]): boolean {
    if (!path || !Array.isArray(patterns) || patterns.length === 0) {
      return false;
    }

    const target: string = PathExcludeHelper.normalize(path);

    if (!target) {
      return false;
    }

    return patterns.some((pattern: string): boolean =>
      PathExcludeHelper.matchOne(target, PathExcludeHelper.normalize(pattern))
    );
  }

  /**
   * Tests a single normalized path against a single normalized pattern.
   * A blank pattern never matches. A pattern containing a glob character is
   * matched as a glob over the whole path; a pattern with no glob character is
   * matched as a folder/file prefix (exact path, or the path lies under the
   * pattern treated as a directory).
   *
   * @param {string} target - The normalized path under test
   * @param {string} pattern - The normalized pattern to test against
   * @return {boolean} True when the pattern matches the path
   */
  protected static matchOne(target: string, pattern: string): boolean {
    if (!pattern) {
      return false;
    }

    if (PathExcludeHelper.GLOB_CHARS.test(pattern)) {
      return PathExcludeHelper.toRegExp(pattern).test(target);
    }

    // Plain prefix: an exact file match, or anything inside the named folder.
    return target === pattern || target.startsWith(`${pattern}/`);
  }

  /**
   * Normalizes a path or pattern for comparison: trims surrounding whitespace,
   * lowercases it (case-insensitive matching), converts backslashes to forward
   * slashes, collapses a leading `./`, drops a leading slash, and drops a single
   * trailing slash so `templates/` and `templates` behave identically.
   *
   * @param {string} value - The raw path or pattern
   * @return {string} The normalized value
   */
  protected static normalize(value: string): string {
    if (!value) {
      return '';
    }

    let result: string = value.trim().toLowerCase().replace(/\\/g, '/');

    if (result.startsWith('./')) {
      result = result.slice(2);
    }

    if (result.startsWith('/')) {
      result = result.slice(1);
    }

    if (result.endsWith('/') && result.length > 1) {
      result = result.slice(0, -1);
    }

    return result;
  }

  /**
   * Compiles a glob pattern into an anchored regular expression. Every regex
   * metacharacter is escaped so only the glob tokens are special: `**` matches
   * across slashes, `*` matches within a single segment, and `?` matches one
   * non-slash character. The expression is anchored at both ends so a pattern
   * must describe the whole path.
   *
   * @param {string} pattern - The normalized glob pattern
   * @return {RegExp} The anchored, case-sensitive regex (input already lowercased)
   */
  protected static toRegExp(pattern: string): RegExp {
    let source: string = '';

    for (let i: number = 0; i < pattern.length; i++) {
      const char: string = pattern[i];

      if (char === '*') {
        if (pattern[i + 1] === '*') {
          // `**` crosses folder boundaries.
          source += '.*';
          i++;
        } else {
          // `*` stays within a single path segment.
          source += '[^/]*';
        }

        continue;
      }

      if (char === '?') {
        source += '[^/]';

        continue;
      }

      source += PathExcludeHelper.escape(char);
    }

    return new RegExp(`^${source}$`);
  }

  /**
   * Escapes a single character for safe use inside a regular expression.
   *
   * @param {string} char - The character to escape
   * @return {string} The escaped character
   */
  protected static escape(char: string): string {
    return char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
}
