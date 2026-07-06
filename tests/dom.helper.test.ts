/** @vitest-environment jsdom */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as DomHelper from '@/helpers/dom.helper';
import { installJsdomDomPolyfill } from './helpers/jsdom-dom';

/**
 * Tests for {@link DomHelper}, the config-driven DOM create/update layer every
 * modal and renderer builds through. The suite runs under jsdom and asserts the
 * real element output for each config branch:
 * - create/update element, text, classes (string, array, and add/remove object),
 * - attribute writes including the invalid-name swallow,
 * - camelCase-to-kebab style conversion and untouched custom properties,
 * - event wiring and nested children,
 * - the single sanctioned sanitized-html entry point (the diff2html boundary).
 *
 * setSanitizedHtml calls `element.empty()` (an Obsidian prototype augmentation
 * jsdom lacks), so the shared polyfill is installed first.
 */
describe('DomHelper', () => {
  beforeAll((): void => {
    installJsdomDomPolyfill();
  });

  let host: HTMLDivElement;

  beforeEach((): void => {
    host = document.createElement('div');
  });

  describe('create', () => {
    it('creates the tagged element with text and classes and appends it to the container', () => {
      const el: HTMLParagraphElement = DomHelper.create({
        tag: 'p',
        text: 'hello',
        classes: 'greeting',
        container: host,
      });

      expect(el.tagName).toBe('P');
      expect(el.textContent).toBe('hello');
      expect(el.classList.contains('greeting')).toBe(true);
      expect(host.contains(el)).toBe(true);
    });

    it('builds the nested child tree described by the config', () => {
      const el: HTMLDivElement = DomHelper.create({
        tag: 'div',
        children: [
          { tag: 'span', text: 'a', classes: 'first' },
          { tag: 'span', text: 'b', classes: 'second' },
        ],
      });

      const spans: NodeListOf<HTMLSpanElement> = el.querySelectorAll('span');

      expect(spans).toHaveLength(2);
      expect(spans[0].textContent).toBe('a');
      expect(spans[0].classList.contains('first')).toBe(true);
      expect(spans[1].textContent).toBe('b');
    });

    it('leaves the element detached when no container is given', () => {
      const el: HTMLSpanElement = DomHelper.create({ tag: 'span' });

      expect(el.parentNode).toBeNull();
    });
  });

  describe('createFragment', () => {
    it('returns a fragment carrying every configured child', () => {
      const fragment: DocumentFragment = DomHelper.createFragment([
        { tag: 'li', text: 'one' },
        { tag: 'li', text: 'two' },
      ]);

      expect(fragment.childNodes).toHaveLength(2);
      host.appendChild(fragment);
      expect(host.querySelectorAll('li')).toHaveLength(2);
      expect(host.textContent).toBe('onetwo');
    });
  });

  describe('update classes', () => {
    it('adds a single class from a string', () => {
      DomHelper.update(host, { classes: 'solo' });

      expect(host.classList.contains('solo')).toBe(true);
    });

    it('adds every class from an array', () => {
      DomHelper.update(host, { classes: ['alpha', 'beta'] });

      expect(host.classList.contains('alpha')).toBe(true);
      expect(host.classList.contains('beta')).toBe(true);
    });

    it('applies the add/remove object form, casting single strings to arrays', () => {
      host.classList.add('stale');

      DomHelper.update(host, { classes: { add: 'fresh', remove: 'stale' } });

      expect(host.classList.contains('fresh')).toBe(true);
      expect(host.classList.contains('stale')).toBe(false);
    });

    it('adds and removes lists of classes in the object form', () => {
      host.classList.add('old-one', 'old-two');

      DomHelper.update(host, {
        classes: { add: ['new-one', 'new-two'], remove: ['old-one', 'old-two'] },
      });

      expect(host.classList.contains('new-one')).toBe(true);
      expect(host.classList.contains('new-two')).toBe(true);
      expect(host.classList.contains('old-one')).toBe(false);
      expect(host.classList.contains('old-two')).toBe(false);
    });

    it('treats an empty object form as a no-op', () => {
      host.classList.add('kept');

      DomHelper.update(host, { classes: {} });

      expect(host.classList.contains('kept')).toBe(true);
      expect(host.classList).toHaveLength(1);
    });
  });

  describe('update text', () => {
    it('sets the text content', () => {
      DomHelper.update(host, { text: 'body' });

      expect(host.textContent).toBe('body');
    });

    it('clears the text content when given an empty string', () => {
      host.textContent = 'stale';

      DomHelper.update(host, { text: '' });

      expect(host.textContent).toBe('');
    });
  });

  describe('update attributes', () => {
    it('sets valid attributes', () => {
      DomHelper.update(host, { attributes: { 'data-role': 'panel', 'title': 'hint' } });

      expect(host.getAttribute('data-role')).toBe('panel');
      expect(host.getAttribute('title')).toBe('hint');
    });

    it('swallows an invalid attribute name and still writes the valid siblings', () => {
      expect((): void =>
        DomHelper.update(host, { attributes: { 'data-ok': '1', 'has space': 'x' } })
      ).not.toThrow();

      expect(host.getAttribute('data-ok')).toBe('1');
      expect(host.hasAttribute('has space')).toBe(false);
    });
  });

  describe('update styles', () => {
    it('converts camelCase keys to kebab-case custom properties', () => {
      DomHelper.update(host, { styles: { paddingInlineStart: '4px' } });

      expect(host.style.getPropertyValue('padding-inline-start')).toBe('4px');
    });

    it('leaves custom-property names (leading --) untouched', () => {
      DomHelper.update(host, { styles: { '--lct-line-width': '2px' } as Partial<CSSStyleDeclaration> });

      expect(host.style.getPropertyValue('--lct-line-width')).toBe('2px');
    });

    it('skips undefined style values', () => {
      DomHelper.update(host, { styles: { color: undefined } });

      expect(host.style.getPropertyValue('color')).toBe('');
    });
  });

  describe('update events and children', () => {
    it('attaches an event listener that fires on dispatch', () => {
      const handler: (event: Event) => void = vi.fn();

      DomHelper.update(host, { events: { click: handler } });
      host.dispatchEvent(new Event('click'));

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('appends configured children to the existing element', () => {
      DomHelper.update(host, { children: [{ tag: 'b', text: 'x' }] });

      expect(host.querySelector('b')?.textContent).toBe('x');
    });
  });

  describe('update guard', () => {
    it('returns without throwing when the element is missing', () => {
      expect((): void =>
        DomHelper.update(null as unknown as HTMLElement, { text: 'ignored' })
      ).not.toThrow();
    });
  });

  describe('setSanitizedHtml', () => {
    it('replaces prior content with the parsed sanitized DOM', () => {
      host.appendChild(document.createElement('hr'));

      DomHelper.setSanitizedHtml(host, '<span class="diff">hi</span>');

      expect(host.querySelector('hr')).toBeNull();
      expect(host.querySelector('span.diff')?.textContent).toBe('hi');
    });

    it('empties the element when given an empty html string', () => {
      host.appendChild(document.createElement('p'));

      DomHelper.setSanitizedHtml(host, '');

      expect(host.childNodes).toHaveLength(0);
    });
  });
});
