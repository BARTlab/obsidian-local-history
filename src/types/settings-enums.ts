/**
 * Defines the types of visual indicators for line changes.
 * Used to determine how changes are displayed in the editor.
 */
export enum IndicatorType {
  line = 'line',
  dot = 'dot',
}

/**
 * Ordered durability of change history, from least to most durable:
 * `file` < `app` < `persist`. `file` drops the history when the file is closed,
 * `app` keeps it only for the running session, and `persist` writes it to disk
 * so it survives an app restart. A single linear choice: there is no separate
 * persist toggle to combine with it.
 */
export enum KeepHistory {
  app = 'app',
  file = 'file',
  persist = 'persist',
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
