import { DomHelper } from '@/helpers/dom.helper';
import type { ToolbarButtonConfig } from '@/types';
import { setIcon } from 'obsidian';

/**
 * Shared toolbar construction for the two history modals. It owns the toolbar
 * structure - a flat row of icon-button groups - so both modals build identical
 * DOM from their own config data. Each modal decides which groups and buttons to
 * add and in what order (that stays modal-specific); the builder only knows how a
 * group and a button are created, so the two toolbars can never drift in look,
 * class names, icons, or accessible labels.
 *
 * The builder is a plain object the modal instantiates against its live toolbar
 * container (per ADR-11: deep collaborators, not DI services).
 */
export class ToolbarBuilder {
  /**
   * @param {HTMLElement} container - The toolbar element groups are appended to.
   */
  public constructor(protected readonly container: HTMLElement) {}

  /**
   * Creates one toolbar group: a flat row of icon buttons. The modifier class
   * controls the group's placement (the destructive actions are pinned to the
   * left edge, the rest are right-aligned) and is the only per-group styling
   * hook now that the toolbar is built from plain elements rather than Setting
   * rows.
   *
   * @param {string} modifier - The group's modifier class
   * @return {HTMLElement} The created group container
   */
  public addGroup(modifier: string): HTMLElement {
    return DomHelper.create({
      tag: 'div',
      classes: ['lct-modal-toolbar-group', modifier],
      container: this.container,
    });
  }

  /**
   * Builds one accessible icon button inside a toolbar group: a native button
   * carrying Obsidian's .clickable-icon look (hover background, size, and radius
   * come from the theme), an aria-label that doubles as the hover tooltip, and a
   * click handler. It shows only the icon but is never a label-less control for
   * keyboard or screen-reader users. The warning option adds the destructive
   * accent (.lct-toolbar-warning) for the restore-original and remove-history
   * actions; the built-in mod-warning is avoided because on a button it paints a
   * solid error fill that hides the icon.
   *
   * @param {HTMLElement} group - The toolbar group to append the button to
   * @param {ToolbarButtonConfig} config - The button's icon, label, handler, and flags
   * @return {HTMLButtonElement} The created button
   */
  public addButton(group: HTMLElement, config: ToolbarButtonConfig): HTMLButtonElement {
    const button: HTMLButtonElement = DomHelper.create({
      tag: 'button',
      classes: config.warning ? ['clickable-icon', 'lct-toolbar-warning'] : ['clickable-icon'],
      attributes: { 'aria-label': config.label, 'type': 'button' },
      container: group,
      events: {
        click: (): void => {
          void config.onClick();
        },
      },
    });

    setIcon(button, config.icon);

    return button;
  }
}
