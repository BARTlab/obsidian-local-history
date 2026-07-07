/**
 * Minimal stand-in for the `obsidian` module under vitest.
 *
 * The real `obsidian` package ships type declarations only (no runtime
 * implementation), because at runtime the bundle treats it as an external
 * provided by the Obsidian app. Any source file that imports a runtime *value*
 * from `obsidian` (for example `Notice`) therefore cannot be resolved by the
 * vitest module resolver. This stub provides inert constructors for the handful
 * of values the plugin imports as values, so services can be unit-tested
 * without pulling in the Obsidian app. Types are erased at compile time and do
 * not need a stub.
 *
 * Each export is a no-op shell: enough to be `new`-ed or called without
 * throwing. Tests that need to assert on behavior (e.g. that a Notice was
 * shown) should spy on these as needed.
 */

import { StateField } from '@codemirror/state';

/**
 * Real CodeMirror StateField standing in for Obsidian's `editorInfoField`.
 * A test makes a view look like a main or nested editor by creating its state
 * with `editorInfoField.init(() => info)`; states created without the field
 * resolve to `undefined` through `state.field(field, false)`, the same as a
 * plain non-Obsidian editor.
 */
export const editorInfoField = StateField.define<unknown>({
  create: (): unknown => null,
  update: (value: unknown): unknown => value,
});

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
 * Inert replacement for Obsidian's `Plugin` base class. The plugin entry point
 * extends it, so the class must exist as a constructor for `src/main.ts` to be
 * importable under vitest; no behavior is needed because tests never run its
 * lifecycle.
 */
export class Plugin {}

/**
 * Stand-in for Obsidian's `PluginSettingTab` base class, extended by the
 * settings tab. Real Obsidian's constructor stores the `app` and owning
 * `plugin` and mounts a `containerEl` the tab renders into; this double
 * reproduces just that surface so a real tab instance can run `display()` under
 * jsdom. The `containerEl` is created in the constructor, so importing this
 * module in the default node environment never touches `document` until a suite
 * actually mounts a tab under jsdom.
 */
export class PluginSettingTab {
  public app: unknown;
  public plugin: unknown;
  public containerEl: HTMLElement;

  public constructor(app?: unknown, plugin?: unknown) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = document.createElement('div');
  }
}

/**
 * Inert stand-in for Obsidian's `ItemView` base class, extended by the
 * recent-changes view. Real Obsidian mounts a `containerEl`/`contentEl` pair and
 * derives `app` from the hosting leaf; this double reproduces just that surface
 * (plus the no-op `registerEvent`/`registerDomEvent`/`register` cleanup hooks a
 * view drives) so a real view instance can run `onOpen`/`render`/`onClose` under
 * jsdom without throwing. All DOM nodes are created in the constructor, so
 * importing this module in the default node environment never touches `document`
 * until a suite actually mounts a view under jsdom.
 */
export class ItemView {
  public leaf: unknown;
  public app: unknown;
  public containerEl: HTMLElement;
  public contentEl: HTMLElement;

  public constructor(leaf?: unknown) {
    this.leaf = leaf ?? {};
    this.app = (leaf as { app?: unknown } | undefined)?.app ?? { workspace: { on: (): unknown => undefined } };
    this.containerEl = document.createElement('div');
    this.contentEl = document.createElement('div');
    this.containerEl.appendChild(this.contentEl);
  }

  public registerEvent(_ref?: unknown): void {
    // Inert: a view routes native subscriptions through here; the ref is a no-op.
  }

  public registerDomEvent(): void {
    // Inert dom-event registration.
  }

  public register(_cleanup?: unknown): void {
    // Inert: Component cleanup registration, torn down implicitly under test.
  }
}

/**
 * Inert stand-in for Obsidian's `SearchComponent`. Backs the search box the
 * recent-changes view builds in `onOpen`: it mounts a real `<input>` so a suite
 * can drive filtering by dispatching a native `input` event, and `onChange`
 * wires that event through to the view's handler. `setValue` updates the field
 * WITHOUT firing `onChange`, matching the real component (the view relies on
 * that when it clears the box on a file switch).
 */
export class SearchComponent {
  public inputEl: HTMLInputElement;

  public constructor(containerEl?: HTMLElement) {
    this.inputEl = document.createElement('input');
    this.inputEl.type = 'search';

    if (containerEl) {
      containerEl.appendChild(this.inputEl);
    }
  }

  public setPlaceholder(placeholder: string): this {
    this.inputEl.placeholder = placeholder;

    return this;
  }

  public onChange(cb: (value: string) => void): this {
    this.inputEl.addEventListener('input', (): void => cb(this.inputEl.value));

    return this;
  }

  public setValue(value: string): this {
    this.inputEl.value = value;

    return this;
  }

  public getValue(): string {
    return this.inputEl.value;
  }
}

/** Recorded shape of a menu item the {@link Menu} double captured. */
export interface RecordedMenuItem {
  title: string;
  icon: string;
  onClick?: (event?: unknown) => unknown;
}

/** The chainable builder passed to a {@link Menu} `addItem` callback. */
export interface MenuItemBuilder {
  setTitle(title: string): MenuItemBuilder;
  setIcon(icon: string): MenuItemBuilder;
  onClick(handler: (event?: unknown) => unknown): MenuItemBuilder;
}

/**
 * Inert stand-in for Obsidian's `Menu`. The recent-changes view constructs its
 * per-row context menu internally, so the double records every constructed
 * instance on the static `instances` registry and captures each item's title,
 * icon, and `onClick` as the view builds it. A suite reads back the latest
 * instance to fire a specific item (e.g. the row revert) and assert its effect.
 * `showAtMouseEvent` is a no-op: no DOM menu is mounted under test.
 */
export class Menu {
  public static instances: Menu[] = [];

  public items: RecordedMenuItem[] = [];

  public constructor() {
    Menu.instances.push(this);
  }

  public addItem(build: (item: MenuItemBuilder) => void): this {
    const record: RecordedMenuItem = { title: '', icon: '' };
    const item: MenuItemBuilder = {
      setTitle: (title: string): MenuItemBuilder => {
        record.title = title;

        return item;
      },
      setIcon: (icon: string): MenuItemBuilder => {
        record.icon = icon;

        return item;
      },
      onClick: (handler: (event?: unknown) => unknown): MenuItemBuilder => {
        record.onClick = handler;

        return item;
      },
    };

    build(item);
    this.items.push(record);

    return this;
  }

  public showAtMouseEvent(): void {
    // Inert: no native menu is shown under test.
  }
}

/**
 * Inert stand-in for Obsidian's `ButtonComponent`, fired by
 * {@link Setting.addButton}. Records the state the settings tab drives through
 * it - the button text, the destructive and cta flags, the disabled state its
 * purge gating flips, and the click handler - so a suite can assert the gating,
 * the destructive-primary styling, and invoke the handler directly.
 */
export class ButtonComponent {
  public buttonText = '';
  public disabled = false;
  public destructive = false;
  public cta = false;
  public clickHandler?: (event?: unknown) => unknown;

  public setButtonText(text: string): this {
    this.buttonText = text;

    return this;
  }

  public setDisabled(disabled: boolean): this {
    this.disabled = disabled;

    return this;
  }

  public setDestructive(): this {
    this.destructive = true;

    return this;
  }

  public setCta(): this {
    this.cta = true;

    return this;
  }

  public onClick(handler: (event?: unknown) => unknown): this {
    this.clickHandler = handler;

    return this;
  }
}

/** Inert stand-in for Obsidian's `ToggleComponent`, fired by {@link Setting.addToggle}. */
export class ToggleComponent {
  public setValue(_value?: unknown): this {
    return this;
  }

  public onChange(_handler: (value: boolean) => unknown): this {
    return this;
  }
}

/** Inert stand-in for Obsidian's `SliderComponent`, fired by {@link Setting.addSlider}. */
export class SliderComponent {
  public setLimits(_min: number, _max: number, _step: number): this {
    return this;
  }

  public setValue(_value?: unknown): this {
    return this;
  }

  public setDynamicTooltip(): this {
    return this;
  }

  public onChange(_handler: (value: number) => unknown): this {
    return this;
  }
}

/** Inert stand-in for Obsidian's `DropdownComponent`, fired by {@link Setting.addDropdown}. */
export class DropdownComponent {
  public addOption(_value: string, _label: string): this {
    return this;
  }

  public setValue(_value?: unknown): this {
    return this;
  }

  public onChange(_handler: (value: string) => unknown): this {
    return this;
  }
}

/**
 * Stand-in for Obsidian's `TextComponent`, fired by {@link Setting.addText}. It
 * mounts a real `<input>` so the tab's `constrainNumberInput` /
 * `constrainGutterCharInput` helpers can set native attributes on it and tag it
 * through the shared jsdom `addClass` polyfill, and records the `onChange`
 * handler so a suite can drive a row edit and assert the value the tab routes to
 * the settings service (for example through `toCount`). Every constructed
 * component is recorded on the static `instances` registry - the same capture
 * pattern the {@link Menu} and {@link SettingGroup} doubles use - so a suite can
 * read back the rows the tab built and assert their input constraints.
 */
export class TextComponent {
  public static instances: TextComponent[] = [];

  public inputEl: HTMLInputElement;
  public changeHandler?: (value: string) => unknown;

  public constructor() {
    this.inputEl = document.createElement('input');
    this.inputEl.type = 'text';

    TextComponent.instances.push(this);
  }

  public setPlaceholder(placeholder: string): this {
    this.inputEl.placeholder = placeholder;

    return this;
  }

  public setValue(value: string): this {
    this.inputEl.value = value;

    return this;
  }

  public onChange(handler: (value: string) => unknown): this {
    this.changeHandler = handler;

    return this;
  }
}

/**
 * Stand-in for Obsidian's `Setting` builder. The naming/description setters
 * return `this` so builder chains do not throw; the
 * `addText`/`addToggle`/`addDropdown`/`addSlider`/`addButton` builders fire their
 * callback with a component double so the tab's row bodies actually run (the
 * purge button, for one, is only assigned inside its `addButton` callback).
 *
 * `addText` fires a {@link TextComponent} carrying a real `inputEl`, so the
 * tab's numeric/gutter input constraints run against a live input (its
 * `addClass` augmentation resolves through the shared jsdom polyfill) and a
 * suite can assert the resulting `type`/`maxLength`/width-class constraints and
 * the `toCount` parsing the change handler routes to the settings service.
 */
export class Setting {
  public setName(_name?: unknown): this {
    return this;
  }

  public setDesc(_desc?: unknown): this {
    return this;
  }

  public setHeading(): this {
    return this;
  }

  public addText(cb: (text: TextComponent) => unknown): this {
    cb(new TextComponent());

    return this;
  }

  public addToggle(cb: (toggle: ToggleComponent) => unknown): this {
    cb(new ToggleComponent());

    return this;
  }

  public addDropdown(cb: (dropdown: DropdownComponent) => unknown): this {
    cb(new DropdownComponent());

    return this;
  }

  public addSlider(cb: (slider: SliderComponent) => unknown): this {
    cb(new SliderComponent());

    return this;
  }

  public addButton(cb: (button: ButtonComponent) => unknown): this {
    cb(new ButtonComponent());

    return this;
  }
}

/**
 * Stand-in for Obsidian's `SettingGroup` (app 1.11+). Mirrors the builder
 * surface the settings tab uses: `setHeading` (whose heading it records) and
 * `addExtraButton` chain, and `addSetting` synchronously invokes its callback
 * with a fresh {@link Setting} so row-construction code runs under test. Every
 * constructed group is recorded on the static `instances` registry so a suite
 * can assert the tab built the expected sections, in order, by their headings -
 * the same capture pattern the {@link Menu} double uses.
 */
export class SettingGroup {
  public static instances: SettingGroup[] = [];

  public listEl: HTMLElement = document.createElement('div');
  public heading?: string;

  public constructor(_containerEl?: HTMLElement) {
    SettingGroup.instances.push(this);
  }

  public setHeading(heading?: string): this {
    this.heading = heading;

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
 * vitest.
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
