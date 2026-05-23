/** @jest-environment jsdom */

import { describe, expect, it, beforeAll } from '@jest/globals';
import { DiffOutputFormatType, DiffViewMode } from '@/consts';
import { DiffRenderHelper } from '@/helpers/diff-render.helper';
import type { DiffRenderParams, TranslationVars } from '@/types';

/**
 * Tests for {@link DiffRenderHelper} (T08 / D6).
 *
 * The helper is the stateless DOM renderer the history modal delegates the
 * four diff modes to so the folder modal (T12) can reuse the same renderer
 * verbatim. The tests run under jsdom and exercise each mode against a fresh
 * container, asserting on the mode-specific class markers the AC names:
 * - patch: `.lct-patch-container` with the unified-patch text and a copy button,
 * - inline: `.lct-inline-container` with one row per line in `lct-inline-row`,
 * - line-by-line: `.d2h-wrapper.d2h-line`,
 * - side-by-side: `.d2h-wrapper.d2h-side` with two `.d2h-side-column-wrapper`s.
 *
 * The helper also returns the hunk list so the modal can attach per-hunk revert
 * affordances and drive navigation; an extra case pins that the hunk count
 * matches a real edit and is zero when base equals current.
 */
describe('DiffRenderHelper', () => {
  /**
   * Obsidian augments HTMLElement.prototype with `empty()` at runtime; jsdom
   * does not, so we polyfill the minimum the renderer touches (DomHelper.update
   * calls empty() before pasting parsed HTML in the diff2html branch).
   */
  beforeAll((): void => {
    if (!(HTMLElement.prototype as unknown as { empty?: () => void }).empty) {
      (HTMLElement.prototype as unknown as { empty: () => void }).empty = function emptyImpl(this: HTMLElement): void {
        while (this.firstChild) {
          this.removeChild(this.firstChild);
        }
      };
    }
  });

  /**
   * Builds a fresh detached container the renderer writes into; each test
   * works in isolation so a previous mode does not leak DOM into the next.
   *
   * @return {HTMLDivElement} A fresh container element
   */
  const container = (): HTMLDivElement => document.createElement('div');

  /**
   * Inert translator that echoes the key, sufficient for the copy button
   * tooltip and the patch notice text under test.
   *
   * @param {string} key - The translation key
   * @param {TranslationVars} [_vars] - Unused interpolation values
   * @return {string} The key itself
   */
  const echoTranslator = {
    t: (key: string, _vars?: TranslationVars): string => key,
  };

  /**
   * Builds a parameter bundle for the renderer with the supplied base/current
   * line arrays and a defaulted file path / line break / translator.
   *
   * @param {string[]} baseLines - The base lines to diff against
   * @param {string[]} currentLines - The current lines
   * @param {DiffRenderParams['mode']} mode - The diff mode to render
   * @param {HTMLElement} target - The container to render into
   * @return {DiffRenderParams} The full parameter bundle
   */
  const params = (
    baseLines: string[],
    currentLines: string[],
    mode: DiffRenderParams['mode'],
    target: HTMLElement,
  ): DiffRenderParams => ({
    baseLines,
    currentLines,
    lineBreak: '\n',
    mode,
    container: target,
    filePath: 'notes/a.md',
    plugin: echoTranslator,
  });

  describe('patch mode', () => {
    it('renders the lct-patch-container with the unified clean patch text', (): void => {
      const target: HTMLDivElement = container();

      DiffRenderHelper.render(params(['one', 'two'], ['one', 'two-changed'], DiffViewMode.patch, target));

      const patchContainer: HTMLElement | null = target.querySelector('.lct-patch-container');

      expect(patchContainer).not.toBeNull();

      const patchText: HTMLElement | null = target.querySelector('.lct-patch-container .lct-patch-text');

      expect(patchText).not.toBeNull();
      // Context size 0 means the unchanged "one" line never appears in the patch
      // body; only the changed line shows as -/+ entries.
      expect(patchText?.textContent ?? '').toContain('-two');
      expect(patchText?.textContent ?? '').toContain('+two-changed');
      expect(patchText?.textContent ?? '').not.toContain(' one');
    });

    it('renders the copy button with an accessible label and an icon marker', (): void => {
      const target: HTMLDivElement = container();

      DiffRenderHelper.render(params(['a'], ['b'], DiffViewMode.patch, target));

      const copyButton: HTMLButtonElement | null = target.querySelector<HTMLButtonElement>('.lct-patch-copy-button');

      expect(copyButton).not.toBeNull();
      expect(copyButton?.getAttribute('aria-label')).toBe('modal.copy');
      expect(copyButton?.getAttribute('title')).toBe('modal.copy');
      // The stubbed setIcon tags the element with a data-icon attribute so the
      // assertion does not depend on Obsidian's SVG output.
      expect(copyButton?.dataset.icon).toBe('copy');
    });

    it('renders an empty header when the base equals the current content', (): void => {
      const target: HTMLDivElement = container();

      DiffRenderHelper.render(params(['same'], ['same'], DiffViewMode.patch, target));

      const patchText: HTMLElement | null = target.querySelector('.lct-patch-container .lct-patch-text');

      expect(patchText?.textContent ?? '').toContain('--- notes/a.md');
      expect(patchText?.textContent ?? '').toContain('+++ notes/a.md');
      expect(patchText?.textContent ?? '').not.toContain('@@');
    });
  });

  describe('inline mode', () => {
    it('renders the lct-inline-container with one row per diff line', (): void => {
      const target: HTMLDivElement = container();

      DiffRenderHelper.render(params(['one', 'two'], ['one', 'two-changed'], DiffViewMode.inline, target));

      expect(target.querySelector('.lct-inline-container')).not.toBeNull();

      const rows: NodeListOf<Element> = target.querySelectorAll('.lct-inline-container .lct-inline-row');

      // Two rows: one context (unchanged) and one modified (two -> two-changed).
      expect(rows.length).toBeGreaterThanOrEqual(2);
      expect(target.querySelector('.lct-inline-context')).not.toBeNull();
      expect(target.querySelector('.lct-inline-modified')).not.toBeNull();
    });

    it('marks pure additions with lct-inline-added and pure removals with lct-inline-removed', (): void => {
      const targetAdded: HTMLDivElement = container();

      DiffRenderHelper.render(params([], ['one'], DiffViewMode.inline, targetAdded));

      expect(targetAdded.querySelector('.lct-inline-added')).not.toBeNull();

      const targetRemoved: HTMLDivElement = container();

      DiffRenderHelper.render(params(['one'], [], DiffViewMode.inline, targetRemoved));

      expect(targetRemoved.querySelector('.lct-inline-removed')).not.toBeNull();
    });
  });

  describe('line-by-line mode', () => {
    it('renders the d2h-wrapper.d2h-line marker', (): void => {
      const target: HTMLDivElement = container();

      DiffRenderHelper.render(params(['one'], ['two'], DiffOutputFormatType.line, target));

      expect(target.querySelector('.d2h-wrapper.d2h-line')).not.toBeNull();
      // The side-by-side column wrapper must not appear in line-by-line mode.
      expect(target.querySelector('.d2h-side-column-wrapper')).toBeNull();
    });
  });

  describe('side-by-side mode', () => {
    it('renders two d2h-side-column-wrapper columns inside d2h-wrapper.d2h-side', (): void => {
      const target: HTMLDivElement = container();

      DiffRenderHelper.render(params(['one'], ['two'], DiffOutputFormatType.side, target));

      expect(target.querySelector('.d2h-wrapper.d2h-side')).not.toBeNull();
      expect(target.querySelectorAll('.d2h-side-column-wrapper').length).toBe(2);
    });
  });

  describe('hunks return value', () => {
    it('returns a non-empty hunk list when the base differs from the current', (): void => {
      const target: HTMLDivElement = container();

      const result = DiffRenderHelper.render(params(['one', 'two'], ['one', 'two-changed'], DiffViewMode.inline, target));

      expect(result.hunks.length).toBeGreaterThanOrEqual(1);
    });

    it('returns an empty hunk list when the base equals the current', (): void => {
      const target: HTMLDivElement = container();

      const result = DiffRenderHelper.render(params(['same'], ['same'], DiffViewMode.inline, target));

      expect(result.hunks).toEqual([]);
    });
  });
});
