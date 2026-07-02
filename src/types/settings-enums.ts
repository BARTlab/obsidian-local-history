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
