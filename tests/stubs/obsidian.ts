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

/**
 * Inert replacement for Obsidian's `TFolder`.
 */
export class TFolder {
  public path = '';
  public name = '';
}

/**
 * Inert replacement for Obsidian's `MarkdownView`.
 */
export class MarkdownView {}

/**
 * Inert replacement for Obsidian's `Modal` base class.
 */
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
