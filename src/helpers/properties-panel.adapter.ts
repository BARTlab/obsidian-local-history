/**
 * Seam that isolates all undocumented Obsidian DOM selectors and attribute
 * names for the Properties panel (.metadata-editor).  If Obsidian renames
 * these internals, only this file needs to change.
 */

/** CSS selector for the properties panel root element. */
export const METADATA_EDITOR_SEL = '.metadata-properties';

/** CSS selector for a single property row inside the panel. */
export const METADATA_PROPERTY_SEL = '.metadata-property';

/** HTML attribute that stores the property key on each row element. */
export const PROP_KEY_ATTR = 'data-property-key';

/**
 * Returns the .metadata-editor element inside `container`, or null when the
 * panel has not been rendered yet.  Never throws.
 */
export function queryMetadataEditor(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>(METADATA_EDITOR_SEL);
}

/**
 * Returns all .metadata-property row elements inside `editor` as an
 * HTMLElement array.  Returns an empty array when none are present.
 */
export function queryPropertyRows(editor: HTMLElement): HTMLElement[] {
  return Array.from(editor.querySelectorAll<HTMLElement>(METADATA_PROPERTY_SEL));
}

/**
 * Returns the value of the data-property-key attribute on `row`, or null when
 * the attribute is absent.
 */
export function getPropertyKey(row: HTMLElement): string | null {
  return row.getAttribute(PROP_KEY_ATTR);
}
