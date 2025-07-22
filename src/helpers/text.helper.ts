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
      hash |= 0; // Convert to 32-bit integer
    }

    return Math.abs(hash).toString();
  }

  /**
   * Generates a random alphanumeric identifier.
   * Converts a random number to base 36 (alphanumeric) and optionally adds a prefix.
   *
   * @param {string} prefix - Optional prefix to add to the beginning of the ID
   * @return {string} A random alphanumeric string that can be used as an identifier
   */
  public static rndId(prefix?: string): string {
    // return Math.random() * 1000000 | 0;
    return Math.random().toString(36).replace('0.', prefix || '');
  }
}
