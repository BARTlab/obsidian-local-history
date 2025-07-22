import type { LineChangeTrackerSettings } from './types';

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
 * Defines the types of changes that can be tracked in a file.
 * Used to categorize and visually distinguish different kinds of line modifications.
 */
export enum ChangeType {
  changed = 'changed',
  restored = 'restored',

  added = 'added',
  removed = 'removed',
}

/**
 * Default settings for the Line Change Tracker plugin.
 * Defines initial values for all configurable options including
 * - Indicator type (line or dot)
 * - History retention policy
 * - Line indicator width
 * - Which change types to display
 * - Gutter characters for different change types
 */
export const DEFAULT_SETTINGS: LineChangeTrackerSettings = {
  type: IndicatorType.line,
  keep: KeepHistory.file,
  allowedExtensions: 'md, txt, csv, json, yaml',
  ignoreNewFiles: true,

  line: {
    width: 2
  },

  show: {
    changed: true,
    restored: true,
    added: true,
    removed: true,
  },

  gutter: {
    changed: '⥂',
    added: '⤷',
    restored: '⤺',
    removed: '⤎',
  },
};

/**
 * ID for the plugin's style element in the DOM.
 * Used to identify and manipulate the CSS styles for line change indicators.
 */
export const STYLE_ID = 'line-change-tracker-styles';

/**
 * Default ID for the plugin's status bar item.
 * Used when creating and referencing the status bar element that displays change information.
 */
export const STATUSBAR_ITEM_ID = 'default';

/**
 * Enum of Obsidian vault events that the plugin can listen to.
 * These events are triggered when files in the vault are created, modified, deleted, or renamed.
 */
export enum ObsidianVaultEvent {
  create = 'vault.create',
  modify = 'vault.modify',
  delete = 'vault.delete',
  rename = 'vault.rename',
}

/**
 * Enum of Obsidian workspace events that the plugin can listen to.
 * These events are triggered by user interactions with the workspace,
 * such as changing active files, opening/closing windows, and editor actions.
 */
export enum ObsidianWorkspaceEvent {
  activeLeafChange = 'workspace.active-leaf-change',
  layoutChange = 'workspace.layout-change',
  fileOpen = 'workspace.file-open',
  editorMenu = 'workspace.editor-menu',
  fileMenu = 'workspace.file-menu',
  quit = 'workspace.quit',
  resize = 'workspace.resize',
  cssChange = 'workspace.css-change',
  editorChange = 'workspace.editor-change',
  editorPaste = 'workspace.editor-paste',
  editorDrop = 'workspace.editor-drop',
  windowOpen = 'workspace.window-open',
  windowClose = 'workspace.window-close'
}

/**
 * Combined object containing all Obsidian events that the plugin can listen to.
 * Groups vault and workspace events together for easier access and organization.
 */
export const ObsidianEvent = {
  vault: ObsidianVaultEvent,
  workspace: ObsidianWorkspaceEvent,
} as const;

/**
 * Enum of internal plugin events used for communication between components.
 * These events are emitted by the plugin and can be subscribed to by services
 * to react to changes in snapshots or settings.
 */
export enum PluginEvent {
  // snapshots
  snapshotsUpdate = 'snapshots:update',

  // settings
  settingsUpdate = 'settings:update',
}
