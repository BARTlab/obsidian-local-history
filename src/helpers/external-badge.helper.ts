import type { DomElementConfig } from '@/types';
import { setIcon } from 'obsidian';

/**
 * Single source of the external-change badge (D13): the inline marker that
 * distinguishes a version captured from an external change from an editor edit.
 *
 * The badge surfaces on three render sites - the file modal rail, the folder
 * timeline rail, and the recent-changes panel - which previously each carried
 * a byte-identical `makeExternalBadge` / `paintExternalBadges` pair. This helper
 * collapses that duplication into one stateless renderer (T01):
 * - {@link make} returns the DomHelper config for the badge, carrying the icon
 *   id as `data-icon` so the glyph can be mounted after the config tree builds
 *   (`DomHelper.create` does not invoke Obsidian's `setIcon`), and
 * - {@link paint} walks a mounted subtree and applies `setIcon` to every badge
 *   slot, keeping the rail declarative with no per-row imperative DOM building.
 *
 * The badge text is locale-resolved by the caller and passed in, so the helper
 * stays free of any plugin / i18n coupling.
 */
export class ExternalBadgeHelper {
  /** Lucide icon id mounted into every external badge. */
  protected static readonly iconId: string = 'download-cloud';

  /**
   * Builds the inline external-change badge config. The icon id ships as
   * `data-icon` on the wrapper so {@link paint} can mount the glyph after
   * DomHelper builds the config tree; the text is rendered as both the visible
   * label and the accessible name (`aria-label` / `title`) so assistive tech
   * announces the marker.
   *
   * @param {string} text - The locale-resolved badge label
   * @return {DomElementConfig} The badge element config
   */
  public static make(text: string): DomElementConfig {
    return {
      tag: 'span',
      classes: 'lct-version-external-badge',
      attributes: { 'aria-label': text, 'title': text, 'data-icon': this.iconId },
      children: [
        { tag: 'span', classes: 'lct-version-external-badge-icon' },
        { tag: 'span', classes: 'lct-version-external-badge-text', text },
      ],
    };
  }

  /**
   * Walks the rendered subtree of `container` and applies Obsidian's `setIcon`
   * to every external-badge icon slot {@link make} emitted. The icon id is read
   * back from the `data-icon` attribute the config carried. Re-running it on
   * every render keeps the icon in sync when a rail filters or re-orders rows.
   *
   * @param {HTMLElement} container - The subtree to scan for badge slots
   */
  public static paint(container: HTMLElement): void {
    const badges: NodeListOf<HTMLElement> = container.querySelectorAll<HTMLElement>(
      '.lct-version-external-badge',
    );

    badges.forEach((badge: HTMLElement): void => {
      const iconId: string | null = badge.getAttribute('data-icon');
      const slot: HTMLElement | null = badge.querySelector<HTMLElement>('.lct-version-external-badge-icon');

      if (iconId && slot) {
        setIcon(slot, iconId);
      }
    });
  }
}
