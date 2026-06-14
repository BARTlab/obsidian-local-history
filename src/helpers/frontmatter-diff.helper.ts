import { parseYaml } from 'obsidian';

/**
 * Result of comparing frontmatter between two versions of a file.
 * Each array contains the YAML top-level key names that were added, modified,
 * or removed between the old and new versions.
 */
export interface FrontmatterChange {
  added: string[];
  modified: string[];
  removed: string[];
}

const EMPTY: FrontmatterChange = { added: [], modified: [], removed: [] };

/**
 * Extracts the YAML content between the opening and closing '---' delimiters
 * from an array of lines.  Returns null when the frontmatter block is absent or
 * unclosed so callers can treat that as "no frontmatter".
 */
function extractYamlBlock(lines: string[]): string | null {
  if (!lines.length || lines[0].trim() !== '---') {
    return null;
  }

  // Search for the closing delimiter starting at line 1.
  const closeIdx = lines.indexOf('---', 1);

  if (closeIdx === -1) {
    return null;
  }

  return lines.slice(1, closeIdx).join('\n');
}

/**
 * Parses a YAML block into a record of top-level string keys.
 * Returns an empty object on any parse error so the diff degrades gracefully.
 */
function parseBlock(yaml: string): Record<string, unknown> {
  try {
    const parsed: unknown = parseYaml(yaml);

    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // parseYaml may throw on malformed YAML - treat as empty.
  }

  return {};
}

/**
 * Serialises a value to a stable string for equality comparison.
 * JSON.stringify is sufficient because parseYaml returns plain JS objects.
 */
function serialise(value: unknown): string {
  return JSON.stringify(value) ?? 'null';
}

/**
 * Computes which frontmatter property keys were added, modified, or removed
 * between `oldLines` and `newLines`.
 *
 * The function is pure: it reads no external state and produces no side effects.
 * It uses Obsidian's `parseYaml` to handle multiline values (lists, nested
 * objects) correctly - only the top-level key appears in the result, never
 * individual lines of a multiline value.
 *
 * @param oldLines - File content at the baseline (snapshot), split into lines
 * @param newLines - File content at the current state, split into lines
 * @returns A {@link FrontmatterChange} describing the key-level differences
 */
export function diffFrontmatter(oldLines: string[], newLines: string[]): FrontmatterChange {
  const oldYaml = extractYamlBlock(oldLines ?? []);
  const newYaml = extractYamlBlock(newLines ?? []);

  // No frontmatter in either version - nothing to report.
  if (oldYaml === null && newYaml === null) {
    return EMPTY;
  }

  const oldProps = oldYaml !== null ? parseBlock(oldYaml) : {};
  const newProps = newYaml !== null ? parseBlock(newYaml) : {};

  const oldKeys = new Set(Object.keys(oldProps));
  const newKeys = new Set(Object.keys(newProps));

  const added: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];

  for (const key of newKeys) {
    if (!oldKeys.has(key)) {
      added.push(key);
    } else if (serialise(newProps[key]) !== serialise(oldProps[key])) {
      modified.push(key);
    }
  }

  for (const key of oldKeys) {
    if (!newKeys.has(key)) {
      removed.push(key);
    }
  }

  return { added, modified, removed };
}
