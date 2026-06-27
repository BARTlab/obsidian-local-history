/**
 * Minimal CommonJS-friendly stand-in for the `obsidian` module under Jest.
 *
 * The real `obsidian` package ships type declarations only (no runtime
 * implementation), because at runtime the bundle treats it as an external
 * provided by the Obsidian app. Any source file that imports a runtime *value*
 * from `obsidian` (for example `Notice`) therefore cannot be resolved by the
 * Jest module resolver. This stub provides inert constructors for the handful
 * of values the plugin imports as values, so services can be unit-tested
 * without pulling in the Obsidian app. Types are erased at compile time and do
 * not need a stub.
 *
 * Each export is a no-op shell: enough to be `new`-ed or called without
 * throwing. Tests that need to assert on behavior (e.g. that a Notice was
 * shown) should spy on these as needed.
 */

/**
 * Inert replacement for Obsidian's `Notice` toast. Records its message so a
 * test can assert on it if needed, but otherwise does nothing.
 */
export class Notice {
  public message: string;

  public constructor(message?: string | DocumentFragment) {
    this.message = typeof message === 'string' ? message : '';
  }

  public setMessage(): this {
    return this;
  }

  public hide(): void {
    // no-op
  }
}

/**
 * Inert replacement for Obsidian's `TFile`. Only the shape is relevant; tests
 * construct file-like objects directly when they need real fields.
 */
export class TFile {
  public path = '';
  public name = '';
  public extension = '';
}

/** Inert replacement for Obsidian's `TFolder`. */
export class TFolder {
  public path = '';
  public name = '';
}

/** Inert replacement for Obsidian's `MarkdownView`. */
export class MarkdownView {}

/** Inert replacement for Obsidian's `Modal` base class. */
export class Modal {
  public open(): void {
    // no-op
  }

  public close(): void {
    // no-op
  }
}

/**
 * Inert replacement for Obsidian's `Setting` builder. Every chainable method
 * returns `this` so builder chains do not throw under test.
 */
export class Setting {
  public setName(): this {
    return this;
  }

  public setDesc(): this {
    return this;
  }

  public setHeading(): this {
    return this;
  }

  public addText(): this {
    return this;
  }

  public addToggle(): this {
    return this;
  }

  public addDropdown(): this {
    return this;
  }

  public addSlider(): this {
    return this;
  }

  public addButton(): this {
    return this;
  }
}

/**
 * Inert replacement for Obsidian's `SettingGroup` (app 1.11+). Mirrors the
 * builder surface the settings tab uses: `setHeading` and `addExtraButton`
 * chain, `addSetting` synchronously invokes its callback with a fresh inert
 * `Setting` so row-construction code runs under test.
 */
export class SettingGroup {
  public listEl: HTMLElement = document.createElement('div');

  public setHeading(): this {
    return this;
  }

  public addClass(): this {
    return this;
  }

  public addSetting(cb: (setting: Setting) => void): this {
    cb(new Setting());

    return this;
  }

  public addExtraButton(): this {
    return this;
  }
}

/**
 * Inert replacement for Obsidian's `setIcon`. Records the requested icon name
 * on the element so tests can assert on it; otherwise does nothing because the
 * real implementation paints SVG markup from Lucide which is irrelevant under
 * Jest.
 *
 * @param {HTMLElement | { dataset?: Record<string, string> }} element - The element to mark
 * @param {string} iconName - The icon name to record
 */
export function setIcon(element: HTMLElement | { dataset?: Record<string, string> }, iconName: string): void {
  // Tag the element so a test can assert the icon name without depending on
  // Obsidian's SVG output. Falls back to a property on plain objects.
  if (element && typeof element === 'object' && 'dataset' in element && element.dataset) {
    element.dataset.icon = iconName;
  }
}

/**
 * Inert replacement for Obsidian's `sanitizeHTMLToDom`. Parses the input HTML
 * into a DocumentFragment when a DOM is available (jsdom-based tests) so
 * helpers that hand raw HTML through this entry point (e.g. the diff2html
 * renderer) produce real DOM nodes a test can query. Returns null when no DOM
 * is available so importing this stub never requires a DOM in the default node
 * environment.
 *
 * No sanitization is performed: tests run against trusted fixtures, and the
 * real Obsidian implementation strips dangerous markup at the app level.
 *
 * @param {string} [html] - The HTML to parse
 * @return {DocumentFragment | null} The parsed fragment, or null without a DOM
 */
export function sanitizeHTMLToDom(html?: string): DocumentFragment | null {
  if (typeof document === 'undefined') {
    return null;
  }

  const fragment: DocumentFragment = document.createDocumentFragment();

  if (!html) {
    return fragment;
  }

  const template: HTMLTemplateElement = document.createElement('template');

  template.innerHTML = html;
  fragment.appendChild(template.content);

  return fragment;
}

/**
 * Minimal YAML parser that covers the frontmatter patterns used in tests.
 * Handles top-level scalar keys, block sequences (- item), and block mappings.
 * Throws on clearly malformed input so the catch-path in parseBlock is exercised.
 *
 * This is intentionally NOT a full YAML spec implementation - it only needs to
 * produce the same shape as the real Obsidian parseYaml for the test fixtures
 * in this suite (flat key-value, lists, nested objects).
 *
 * @param {string} yaml - YAML text to parse
 * @returns {unknown} Parsed value
 */
export function parseYaml(yaml: string): unknown {
  if (typeof yaml !== 'string') {
    throw new Error('parseYaml: input must be a string');
  }

  const trimmed = yaml.trim();

  if (trimmed === '' || trimmed === 'null' || trimmed === '~') {
    return null;
  }

  return parseYamlValue(trimmed, 0);
}

/** Coerces a raw scalar string to its JS equivalent. */
function coerceScalar(raw: string): unknown {
  const t = raw.trim();

  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null' || t === '~' || t === '') return null;

  // Quoted strings - strip quotes.
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith('\'') && t.endsWith('\''))) {
    return t.slice(1, -1);
  }

  const num = Number(t);

  if (!isNaN(num) && t !== '') return num;

  return t;
}

/**
 * Parses a YAML value that may be a mapping, sequence, or scalar.
 * `indent` is the expected indentation level of child lines.
 */
function parseYamlValue(text: string, indent: number): unknown {
  const lines = text.split('\n');

  // Detect block mapping: first non-empty line contains ': '
  const firstLine = lines[0].replace(/^\s+/, '');

  if (firstLine.startsWith('- ') || firstLine === '-') {
    return parseSequence(lines, indent);
  }

  if (firstLine.includes(': ') || firstLine.endsWith(':')) {
    return parseMapping(lines, indent);
  }

  return coerceScalar(text.trim());
}

/** Parses a YAML block sequence from an array of lines. */
function parseSequence(lines: string[], _indent: number): unknown[] {
  const result: unknown[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const stripped = line.replace(/^\s+/, '');

    if (stripped === '' || stripped.startsWith('#')) {
      i++;
      continue;
    }

    if (stripped.startsWith('- ')) {
      result.push(coerceScalar(stripped.slice(2)));
      i++;
    } else if (stripped === '-') {
      result.push(null);
      i++;
    } else {
      i++;
    }
  }

  return result;
}

/** Parses a YAML block mapping from an array of lines. */
function parseMapping(lines: string[], baseIndent: number): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === '' || line.trim().startsWith('#')) {
      i++;
      continue;
    }

    const currentIndent = line.search(/\S/);

    if (currentIndent < baseIndent) {
      break;
    }

    const colonIdx = line.indexOf(': ');
    const trailingColon = line.replace(/\s+$/, '').endsWith(':') && !line.includes(': ');

    if (colonIdx === -1 && !trailingColon) {
      i++;
      continue;
    }

    let key: string;
    let inlineValue: string | null;

    if (trailingColon) {
      key = line.trim().slice(0, -1).trim();
      inlineValue = null;
    } else {
      key = line.slice(0, colonIdx).trim();
      inlineValue = line.slice(colonIdx + 2).trim();
    }

    // Collect child lines (indented deeper than current line).
    const childLines: string[] = [];

    i++;

    while (i < lines.length) {
      const childLine = lines[i];
      const childIndent = childLine.search(/\S/);

      // Empty lines are part of the child block.
      if (childLine.trim() === '') {
        childLines.push(childLine);
        i++;
        continue;
      }

      if (childIndent > currentIndent) {
        childLines.push(childLine);
        i++;
      } else {
        break;
      }
    }

    if (childLines.some((l) => l.trim() !== '')) {
      // Has a child block - parse it recursively.
      result[key] = parseYamlValue(childLines.join('\n'), currentIndent + 1);
    } else if (inlineValue !== null && inlineValue !== '') {
      result[key] = coerceScalar(inlineValue);
    } else {
      result[key] = null;
    }
  }

  return result;
}
