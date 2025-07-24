import type { DomElementConfig, DomUpdateConfig, DomUpdateConfigClasses } from '@/types';
import { castArray, entries, isArray, isPlainObject, isString, isUndefined } from 'lodash-es';

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

    // apply config to a new element
    this.update(element, config);

    // append to container if provided
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

    // create and append child to new fragment
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

    // classes
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

    // Set text content
    if (!isUndefined(config.text)) {
      element.textContent = config.text;
    }

    // Set html content
    if (!isUndefined(config.html)) {
      const parser: DOMParser = new DOMParser();
      const doc: Document = parser.parseFromString(config.html, 'text/html');

      element.empty();

      Array.from(doc.body.childNodes).forEach((child: ChildNode): void => {
        element.appendChild(child);
      });
    }

    // Set attributes
    if (config.attributes) {
      entries(config.attributes).forEach(([key, value]: [string, string]): void => {
        try {
          element.setAttribute(key, value);
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
        } catch (_error) {
          // empty
        }
      });
    }

    // Apply styles
    if (config.styles) {
      entries(config.styles).forEach(([key, value]): void => {
        if (isUndefined(value)) {
          return;
        }

        try {
          element.style.setProperty(key, String(value));
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
        } catch (_error) {
          // empty
        }
      });
    }

    // Add event listeners
    if (config.events) {
      entries(config.events).forEach(([eventType, handler]): void => {
        element.addEventListener(eventType, handler);
      });
    }

    // Add child elements
    if (config.children) {
      config.children.forEach((childConfig: DomElementConfig): void => {
        element.appendChild(DomHelper.create(childConfig));
      });
    }
  }
}
