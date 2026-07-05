/**
 * Defines the types of visual indicators for line changes.
 * Used to determine how changes are displayed in the editor.
 */
export enum IndicatorType {
  line = 'line',
  dot = 'dot',
}

/**
 * Defines how long to keep change history.
 * Controls whether changes are tracked until the app is closed or until the file is closed.
 */
export enum KeepHistory {
  app = 'app',
  file = 'file',
}

/**
 * Layout of the vault-wide changes panel: a nested folder tree, or a flat file
 * list that shows each file's containing path inline. Persisted so the user's
 * choice survives a restart. The member values are the literal layout strings.
 */
export enum ChangesLayout {
  tree = 'tree',
  flat = 'flat',
}
