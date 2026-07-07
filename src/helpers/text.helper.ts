/**
 * Monotonic, module-level counter backing {@link rndId}. Guarantees every
 * generated id is unique and non-empty for the lifetime of the module.
 */
let idCounter: number = 0;

/**
 * Generates a hash from a string content.
 * Uses a simple algorithm to convert the string to a numeric hash.
 *
 * @param {string} content - The string to hash
 * @return {string} The hash as a string (absolute value)
 */
export function hash(content: string): string {
  let hash: number = 0;

  for (let i: number = 0; i < content.length; i++) {
    hash = ((hash << 5) - hash) + content.charCodeAt(i);
    // Convert to 32-bit integer.
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
export function rndId(prefix?: string): string {
  idCounter += 1;

  return `${prefix ?? ''}${idCounter.toString(36)}`;
}

/**
 * Whether two strings differ only in whitespace: they are not equal, yet they
 * collapse to the same text once every whitespace run is stripped. Used to tag
 * a changed line as a whitespace-only edit so reformatting noise (trailing
 * spaces, tab/space swaps, re-alignment) reads apart from real content edits.
 *
 * @param {string} a - The original line content
 * @param {string} b - The current line content
 * @return {boolean} True when the only difference is whitespace
 */
export function isWhitespaceDiff(a: string, b: string): boolean {
  return a !== b && a.replace(/\s+/g, '') === b.replace(/\s+/g, '');
}

/**
 * Splits document content into the lines the editor sees. Always splits on
 * `/\r?\n/`, never the stored `lineBreak`, so a file mixing CRLF and lone-LF
 * endings decomposes into the same line set the change detector, editor, and
 * diff surface hold. This is the single home of that invariant: every
 * document-decomposition site routes through it instead of re-inlining the
 * split. It never trims or filters.
 *
 * @param {string} content - The document content to decompose
 * @return {string[]} The content split into lines on `/\r?\n/`
 */
export function splitLines(content: string): string[] {
  return content.split(/\r?\n/);
}
