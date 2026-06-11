/** @jest-environment jsdom */

import { describe, expect, it } from '@jest/globals';
import { ExternalBadgeHelper } from '@/helpers/external-badge.helper';
import type { DomElementConfig } from '@/types';

/**
 * Tests for {@link ExternalBadgeHelper} (T01 / T18).
 *
 * The helper is the single source of truth for the external-change badge rendered
 * on three rail sites (file modal, folder timeline, recent-changes panel). The
 * tests cover both public static methods:
 *
 * - {@link ExternalBadgeHelper.make} - returns the DomElementConfig with the
 *   correct class, accessibility attributes, icon marker, and child slots.
 * - {@link ExternalBadgeHelper.paint} - walks a mounted subtree and stamps the
 *   icon onto every badge icon slot via the stub `setIcon` (which records the
 *   icon name as `dataset.icon` so tests can assert without Obsidian's SVG layer).
 */
describe('ExternalBadgeHelper', () => {
  describe('make', () => {
    it('returns a span config with the external-badge class', () => {
      const config: DomElementConfig = ExternalBadgeHelper.make('External');

      expect(config.tag).toBe('span');
      expect(config.classes).toBe('lct-version-external-badge');
    });

    it('sets aria-label and title to the supplied text', () => {
      const config: DomElementConfig = ExternalBadgeHelper.make('External');

      expect(config.attributes?.['aria-label']).toBe('External');
      expect(config.attributes?.['title']).toBe('External');
    });

    it('sets data-icon to the download-cloud icon id', () => {
      const config: DomElementConfig = ExternalBadgeHelper.make('External');

      expect(config.attributes?.['data-icon']).toBe('download-cloud');
    });

    it('includes an icon-slot child with lct-version-external-badge-icon class', () => {
      const config: DomElementConfig = ExternalBadgeHelper.make('External');

      const iconSlot: DomElementConfig | undefined = config.children?.find(
        (c: DomElementConfig) => c.classes === 'lct-version-external-badge-icon',
      );

      expect(iconSlot).toBeDefined();
      expect(iconSlot?.tag).toBe('span');
    });

    it('includes a text-slot child with lct-version-external-badge-text class and the supplied text', () => {
      const config: DomElementConfig = ExternalBadgeHelper.make('External');

      const textSlot: DomElementConfig | undefined = config.children?.find(
        (c: DomElementConfig) => c.classes === 'lct-version-external-badge-text',
      );

      expect(textSlot).toBeDefined();
      expect(textSlot?.tag).toBe('span');
      expect(textSlot?.text).toBe('External');
    });

    it('reflects a different text value in the attributes and text slot', () => {
      const config: DomElementConfig = ExternalBadgeHelper.make('Externe');

      expect(config.attributes?.['aria-label']).toBe('Externe');
      expect(config.attributes?.['title']).toBe('Externe');

      const textSlot: DomElementConfig | undefined = config.children?.find(
        (c: DomElementConfig) => c.classes === 'lct-version-external-badge-text',
      );

      expect(textSlot?.text).toBe('Externe');
    });
  });

  describe('paint', () => {
    /**
     * Builds a minimal badge subtree that mirrors what DomHelper.create would
     * produce from the config returned by {@link ExternalBadgeHelper.make}:
     * - an outer `.lct-version-external-badge` span with `data-icon` set, and
     * - an inner `.lct-version-external-badge-icon` span as the icon slot.
     *
     * The stub `setIcon` (in tests/stubs/obsidian.ts) writes the icon name to
     * `dataset.icon` on the slot element, so assertions can check it without the
     * Obsidian SVG layer.
     *
     * @param {HTMLElement} container - The parent to append the badge into
     * @param {string} [iconId] - The data-icon value; defaults to 'download-cloud'
     * @return {HTMLElement} The appended icon slot element
     */
    const appendBadge = (container: HTMLElement, iconId = 'download-cloud'): HTMLElement => {
      const badge: HTMLSpanElement = document.createElement('span');

      badge.className = 'lct-version-external-badge';
      badge.setAttribute('data-icon', iconId);

      const iconSlot: HTMLSpanElement = document.createElement('span');

      iconSlot.className = 'lct-version-external-badge-icon';
      badge.appendChild(iconSlot);
      container.appendChild(badge);

      return iconSlot;
    };

    it('stamps the download-cloud icon onto every badge icon slot in the container', () => {
      const container: HTMLDivElement = document.createElement('div');
      const slotA: HTMLElement = appendBadge(container);
      const slotB: HTMLElement = appendBadge(container);

      ExternalBadgeHelper.paint(container);

      expect(slotA.dataset.icon).toBe('download-cloud');
      expect(slotB.dataset.icon).toBe('download-cloud');
    });

    it('is a no-op when the container has no badge elements', () => {
      const container: HTMLDivElement = document.createElement('div');
      container.appendChild(document.createElement('span'));

      // Must not throw.
      expect(() => ExternalBadgeHelper.paint(container)).not.toThrow();
    });

    it('skips a badge whose data-icon attribute is missing', () => {
      const container: HTMLDivElement = document.createElement('div');
      const badge: HTMLSpanElement = document.createElement('span');

      badge.className = 'lct-version-external-badge';
      // Intentionally no data-icon attribute.
      const iconSlot: HTMLSpanElement = document.createElement('span');

      iconSlot.className = 'lct-version-external-badge-icon';
      badge.appendChild(iconSlot);
      container.appendChild(badge);

      ExternalBadgeHelper.paint(container);

      // setIcon was never called so dataset.icon stays undefined.
      expect(iconSlot.dataset.icon).toBeUndefined();
    });

    it('skips a badge whose icon slot is absent', () => {
      const container: HTMLDivElement = document.createElement('div');
      const badge: HTMLSpanElement = document.createElement('span');

      badge.className = 'lct-version-external-badge';
      badge.setAttribute('data-icon', 'download-cloud');
      // Intentionally no icon slot child.
      container.appendChild(badge);

      // Must not throw.
      expect(() => ExternalBadgeHelper.paint(container)).not.toThrow();
    });
  });
});
