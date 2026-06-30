import type { MenuItemWithSubmenu } from '@/types';
import type { Menu, MenuItem } from 'obsidian';

/**
 * Typed wrapper around Obsidian's undocumented `MenuItem.setSubmenu()`.
 *
 * Decisions:
 * - The minimum Obsidian version that ships `setSubmenu()` is 1.5, which is the
 *   floor we declare via `manifest.json` `minAppVersion`. The wrapper assumes
 *   the host honours that contract and does not soft-fail at runtime: a missing
 *   method on an older host would indicate the user is running below the
 *   declared minimum, which is a setup issue, not a feature we accommodate.
 * - The cast is centralised here so call sites can write
 *   `MenuHelper.setSubmenu(item)` and receive a typed `Menu` back without any
 *   `// @ts-expect-error` or `as any` sprinkled across the codebase.
 *
 * Attaches a child submenu to the given parent menu item and returns the
 * resulting `Menu` instance, fully typed. The returned menu accepts the usual
 * `addItem`/`addSeparator` API.
 *
 * @param {MenuItem} item - The parent menu item to convert into a submenu anchor
 * @return {Menu} The freshly created child menu that owns the submenu items
 */
export function setSubmenu(item: MenuItem): Menu {
  return (item as MenuItemWithSubmenu).setSubmenu();
}
