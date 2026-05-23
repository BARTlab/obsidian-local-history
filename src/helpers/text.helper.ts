/**
 * Monotonic, module-level counter backing {@link TextHelper.rndId}. Guarantees
 * every generated id is unique and non-empty for the lifetime of the module.
 */
let idCounter: number = 0;

/**
 * Helper class for text-related operations.
 * Provides utility methods for working with strings and generating identifiers.
 */
export class TextHelper {
  /**
   * Generates a hash from a string content.
   * Uses a simple algorithm to convert the string to a numeric hash.
   *
   * @param {string} content - The string to hash
   * @return {string} The hash as a string (absolute value)
   */
  public static hash(content: string): string {
    let hash: number = 0;

    for (let i: number = 0; i < content.length; i++) {
      hash = ((hash << 5) - hash) + content.charCodeAt(i);
      /**
       * Convert to 32-bit integer.
       */
      hash |= 0;
    }

    return Math.abs(hash).toString();
  }

  /**
   * Generates a unique alphanumeric identifier.
   * Increments a monotonic counter and renders it in base 36 (alphanumeric),
   * optionally prefixed. Unlike a Math.random scheme it never yields empty,
   * truncated, or colliding ids, which TrackerLine.isEq and key rely on.
   *
   * @param {string} prefix - Optional prefix to add to the beginning of the ID
   * @return {string} A unique alphanumeric string that can be used as an identifier
   */
  public static rndId(prefix?: string): string {
    idCounter += 1;

    return `${prefix ?? ''}${idCounter.toString(36)}`;
  }
}
