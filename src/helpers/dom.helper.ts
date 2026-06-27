import type { DomElementConfig, DomUpdateConfig, DomUpdateConfigClasses } from '@/types';
import { castArray, entries, isArray, isPlainObject, isString, isUndefined } from 'lodash-es';
import { sanitizeHTMLToDom } from 'obsidian';

/**
 * Utility class for creating and updating DOM elements with type safety.
 * Follows Google TypeScript style guide conventions.
 */
export class DomHelper {
  /**
   * Creates a DOM element based on the provided configuration.
   * @param {DomElementConfig} config - Configuration object for the element
   * @return {HTMLElement} The created HTML element with proper typing
   */
  public static create<K extends keyof HTMLElementTagNameMap>(
    config: DomElementConfig & { tag: K }
  ): HTMLElementTagNameMap[K] {
    const element: HTMLElementTagNameMap[K] = document.createElement(config.tag);

    this.update(element, config);

    if (config.container) {
      config.container.appendChild(element);
    }

    return element;
  }

  /**
   * Creates a DocumentFragment with child elements based on the provided configuration.
   * @param {DomElementConfig[]} children - Array of child element configurations
   * @return {DocumentFragment} The created DocumentFragment with child elements
   */
  public static createFragment(children: DomElementConfig[]): DocumentFragment {
    const fragment: DocumentFragment = document.createDocumentFragment();

    children.forEach((childConfig: DomElementConfig): void => {
      fragment.appendChild(DomHelper.create(childConfig));
    });

    return fragment;
  }

  /**
   * Updates an existing DOM element based on the provided configuration.
   * @param {HTMLElement} element - The element to update
   * @param {DomUpdateConfig} config - Configuration object for updating the element
   * @return {void}
   */
  public static update(element: HTMLElement, config: DomUpdateConfig): void {
    if (!element) {
      return;
    }

    if (config.classes) {
      if (isArray(config.classes) || isString(config.classes)) {
        element.classList.add(
          ...castArray(config.classes)
        );
      }

      if (isPlainObject(config.classes)) {
        element.classList.add(
          ...castArray((config.classes as DomUpdateConfigClasses).add ?? [])
        );

        element.classList.remove(
          ...castArray((config.classes as DomUpdateConfigClasses).remove ?? [])
        );
      }
    }

    if (!isUndefined(config.text)) {
      element.textContent = config.text;
    }

    if (config.attributes) {
      entries(config.attributes).forEach(([key, value]: [string, string]): void => {
        try {
          element.setAttribute(key, value);
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
        } catch (_error) {
          /**
           * Swallow invalid attribute names; the element keeps its prior state.
           */
        }
      });
    }

    if (config.styles) {
      entries(config.styles).forEach(([key, value]): void => {
        if (isUndefined(value)) {
          return;
        }

        try {
          /**
           * CSSStyleDeclaration keys are camelCase (e.g. paddingInlineStart),
           * but setProperty expects the CSS custom-property/kebab name. Convert
           * camelCase to kebab-case so the value is actually applied; leave
           * custom properties (--foo) untouched.
           */
          const cssName: string = key.startsWith('--')
            ? key
            : key.replace(/[A-Z]/g, (match: string): string => `-${match.toLowerCase()}`);

          element.style.setProperty(cssName, String(value));
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
        } catch (_error) {
          /**
           * Swallow invalid style values; the element keeps its prior state.
           */
        }
      });
    }

    if (config.events) {
      entries(config.events).forEach(([eventType, handler]): void => {
        element.addEventListener(eventType, handler);
      });
    }

    if (config.children) {
      config.children.forEach((childConfig: DomElementConfig): void => {
        element.appendChild(DomHelper.create(childConfig));
      });
    }
  }

  /**
   * Replaces an element's content with sanitized HTML. The single sanctioned
   * entry point for pasting an HTML string into the DOM: only the diff2html
   * renderer uses it, for the by-design markup diff2html emits (see
   * {@link DiffRenderHelper}). Every other DOM write goes through the structured
   * create/update config, which carries no HTML-string escape hatch.
   *
   * @param {HTMLElement} element - The element whose content is replaced
   * @param {string} html - The HTML string to sanitize and insert
   * @return {void}
   */
  public static setSanitizedHtml(element: HTMLElement, html: string): void {
    element.empty();
    element.appendChild(sanitizeHTMLToDom(html));
  }
}
