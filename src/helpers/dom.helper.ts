import type { DomElementConfig, DomUpdateConfig } from '@/types';
import { entries, isArray, isUndefined } from 'lodash-es';

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

    // Add classes
    if (config.classes) {
      const classes: string[] = isArray(config.classes) ? config.classes : [config.classes];
      element.classList.add(...classes);
    }

    // Set text content
    if (!isUndefined(config.text)) {
      element.textContent = config.text;
    }

    // Set attributes
    if (config.attributes) {
      entries(config.attributes).forEach(([key, value]) => {
        element.setAttribute(key, value);
      });
    }

    // Apply styles - Fixed TypeScript error
    if (config.styles) {
      entries(config.styles).forEach(([key, value]) => {
        if (!isUndefined(value)) {
          // Fix: Use proper type assertion to avoid conversion error
          (element.style as unknown as Record<string, string>)[key] = String(value);
        }
      });
    }

    // Add event listeners
    if (config.events) {
      entries(config.events).forEach(([eventType, handler]) => {
        element.addEventListener(eventType, handler);
      });
    }

    // Add child elements
    if (config.children) {
      config.children.forEach((childConfig) => {
        const childElement = DomHelper.create(childConfig);
        element.appendChild(childElement);
      });
    }

    // Append to container if provided
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
      const childElement: HTMLElement = DomHelper.create(childConfig);
      fragment.appendChild(childElement);
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
    // Add classes
    if (config.classes) {
      const classes: string[] = isArray(config.classes) ? config.classes : [config.classes];
      element.classList.add(...classes);
    }

    // Set text content
    if (!isUndefined(config.text)) {
      element.textContent = config.text;
    }

    // Set attributes
    if (config.attributes) {
      entries(config.attributes).forEach(([key, value]: [string, string]): void => {
        element.setAttribute(key, value);
      });
    }

    // Apply styles
    if (config.styles) {
      entries(config.styles).forEach(([key, value]): void => {
        if (!isUndefined(value)) {
          // Use proper type assertion to avoid conversion error
          (element.style as unknown as Record<string, string>)[key] = String(value);
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
        const childElement = DomHelper.create(childConfig);
        element.appendChild(childElement);
      });
    }
  }
}
