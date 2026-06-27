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

  /**
   * A line that exists in the original and differs from it only in whitespace
   * (spaces or tabs). Shown in its own muted color so reformatting noise reads
   * apart from real content edits, mirroring a JetBrains-style whitespace diff.
   */
  whitespace = 'whitespace',
}

/**
 * Enum representing the available output formats for displaying differences.
 */
export enum DiffOutputFormatType {
  line = 'line-by-line',
  side = 'side-by-side',
}

/**
 * The two text-oriented diff views the history modals render directly, as
 * opposed to the diff2html-backed {@link DiffOutputFormatType} views. `patch`
 * shows the unified clean patch text and `inline` shows word-level highlights
 * inside modified lines. The member values are the literal mode strings the
 * modals interpolate into `modal.mode.${mode}` translation lookups, so they
 * must stay byte-equal.
 */
export enum DiffViewMode {
  patch = 'patch',
  inline = 'inline',
}

/**
 * Which end of the version list the Home/End keys jump the selection to.
 * `first` selects the topmost (newest) entry, `last` the bottommost (the
 * synthetic baseline or the oldest version).
 */
export enum VersionListEdge {
  first = 'first',
  last = 'last',
}

/**
 * Direction in which to walk the set of changed lines when navigating.
 */
export enum NavigationDirection {
  next = 'next',
  previous = 'previous',
}

/**
 * Direction in which to walk a flat selection list with the keyboard. `down`
 * moves toward the end of the list (the visually lower entry), `up` toward the
 * start.
 */
export enum ListSelectionDirection {
  up = 'up',
  down = 'down',
}

/**
 * Discriminator for the action a version represents relative to its previous
 * point on the timeline. Mirrors the three semantic transitions the user cares
 * about in the rail and panel: a non-empty content born from emptiness, a
 * non-empty content blanked out, and any other content-changing diff. The
 * member values are the literal action keys used to build the
 * `modal.version.action.*` translation lookups, so they must stay byte-equal.
 */
export enum VersionAction {
  created = 'created',
  modified = 'modified',
  cleared = 'cleared',
}

/**
 * Discriminator for the three kinds of points that make up a folder timeline.
 * The member values are the literal kind strings the folder modal interpolates
 * into `modal.folder.timeline.${kind}` translation lookups, so they must stay
 * byte-equal.
 *
 * - `capture` is a per-file version captured by the cadence (or a labelled
 *   capture), so the timeline lists one point per `FileVersion.timestamp`.
 * - `delete` is a tombstone point, taken from `FileSnapshot.deletedTimestamp`
 *   when the snapshot represents a deleted file.
 * - `moveIn` is a move-in point, taken from `FileSnapshot.movedIntoAt` when the
 *   snapshot was re-keyed to a new path by a cross-directory move.
 */
export enum FolderTimelinePointKind {
  capture = 'capture',
  delete = 'delete',
  moveIn = 'move-in',
}

/**
 * Per-file status reported by `FolderDeltaHelper.compareAt`. One of:
 *
 * - `added` - the file did not exist at T but exists now (or was moved into the
 *   folder after T). The base is empty; the current is the live content.
 * - `modified` - the file existed at T with a different content than now.
 * - `deleted` - the file existed at T but is gone now (a tombstone whose
 *   `deletedTimestamp` is after T). The base is the content at T; the current
 *   is empty.
 * - `none` - no diff worth showing at T: identical content for a live snapshot,
 *   or a tombstone that was already deleted before T.
 */
export enum FolderDeltaStatus {
  added = 'added',
  modified = 'modified',
  deleted = 'deleted',
  none = 'none',
}

/**
 * The kind of change a single line represents in the inline (word-level) diff
 * view. `context` is an unchanged line, `added` a pure addition, `removed` a
 * pure removal, and `modified` a removed/added pair that stand for the same
 * logical line so the renderer can show word-level spans for each side. This is
 * a distinct domain from {@link ChangeType} (the gutter change kinds), so it is
 * its own enum.
 */
export enum WordDiffLineType {
  context = 'context',
  added = 'added',
  removed = 'removed',
  modified = 'modified',
}

/**
 * Which CodeMirror surface an extension binds to. `editor` extensions are
 * `ViewPlugin` instances and `gutter` extensions are gutter configurations; the
 * extensions service uses this to pick the right factory overload.
 */
export enum ExtensionKind {
  editor = 'editor',
  gutter = 'gutter',
}

/**
 * The mutation an {@link ObservableMap} notifies its listeners about. `set`,
 * `delete`, and `clear` mirror the overridden map methods, and `update` is a
 * manual notification a holder fires when a value mutates in place without a
 * key reassignment.
 */
export enum MapChangeAction {
  set = 'set',
  delete = 'delete',
  clear = 'clear',
  update = 'update',
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
  keep: KeepHistory.app,
  persist: true,
  allowedExtensions: 'md, txt, csv, json, yaml',
  excludePaths: [],
  excludePathsCaseSensitive: false,
  ignoreNewFiles: true,
  treeHighlight: true,
  propertiesHighlight: true,
  readingModeIndicator: false,

  retention: {
    maxEntries: 200,
    maxAgeDays: 30,
    maxDeletedEntries: 100,
    maxDeletedAgeDays: 30,
  },

  snapshots: {
    enabled: true,
    intervalMs: 5 * 60 * 1000,
    editThreshold: 10,
    maxVersions: 50,
    maxVersionAgeDays: 14,
  },

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
 * The `show.*` setting flags toggled together by the gutter "show changes" menu
 * item. Listing them in one place keeps the composite toggle and its read in
 * sync.
 */
export const SHOW_CHANGE_KEYS = ['show.changed', 'show.restored', 'show.added', 'show.removed'] as const;

/**
 * Stable view type id for the Recent changes side panel. Registered with
 * Obsidian once at plugin load so the right sidebar can host one navigator
 * leaf at a time, and used by the reveal entry point to look up the existing
 * leaf instead of spawning duplicates.
 */
export const RECENT_CHANGES_VIEW_TYPE: string = 'line-change-tracker-recent-changes';

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
  viewportMenu = 'workspace.markdown-viewport-menu',
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
  /**
   * Emitted when the snapshot store changes, so views can refresh.
   */
  snapshotsUpdate = 'snapshots:update',

  /**
   * Emitted when the plugin settings change, so consumers can re-read them.
   */
  settingsUpdate = 'settings:update',
}

/**
 * Default line break used to render diffs in the folder modal. The snapshot
 * owns the per-file line break, but the modal renders diffs across many files;
 * a single conservative default is enough because the diff renderer only joins
 * lines back together for the unified-patch input, and the rendered output uses
 * the same separator on both sides.
 */
export const DEFAULT_LINE_BREAK: string = '\n';

/**
 * Sentinel id for the Original entry in the version list. It is the only base
 * shown when the file has no captured snapshots yet, and it diffs the current
 * state against the file's original captured content. Once snapshots exist the
 * rail lists the real versions instead (the latest one already shows "what
 * changed since the last save"), so this id is no longer offered for selection;
 * a stale version id still routes here and falls back to the latest snapshot.
 * Real versions are keyed by their own id, which is never this value.
 */
export const ORIGINAL_BASE_ID: string = 'original';

/**
 * Pixels the diff pane scrolls per up/down arrow press when it holds focus.
 * Roughly two diff rows (each ~24px tall), so an arrow nudges the content a
 * line or two at a time, matching a native focused-scroll-container feel.
 */
export const DIFF_SCROLL_STEP_PX: number = 48;

/**
 * Marker line emitted by the diff library to flag a missing trailing newline.
 * It carries no content and must be ignored when reconstructing line text.
 */
export const NO_NEWLINE_MARKER: string = '\\ No newline at end of file';

/**
 * Glyph rendered for the gutter revert affordance: a left arrow that reads as
 * "send this block back to the base". Kept as a constant so the visual and its
 * accessible label stay in one place.
 */
export const REVERT_GLYPH: string = '↩';

/**
 * Number of milliseconds in a day, used to translate an age cap (in days) from
 * settings into a timestamp comparison when evicting old entries or versions.
 */
export const MS_PER_DAY: number = 24 * 60 * 60 * 1000;

/**
 * Debounce window (ms) for disk writes so a burst of snapshot updates collapses
 * into a single save instead of writing on every keystroke-driven change.
 */
export const SAVE_DEBOUNCE_MS: number = 1500;

/**
 * Subdirectory under the plugin folder that holds the per-note history shards.
 * Each shard is one self-describing `{ version, snapshot }` JSON file named by a
 * hash of the note's vault-relative path (see {@link ShardNameHelper}). The
 * directory listing is the source of truth for which notes have history; there
 * is deliberately no index or manifest file (ADR-10).
 */
export const HISTORY_SHARD_DIR: string = 'history';

/**
 * Cadence at which the version codec forces a full keyframe inside the delta
 * chain: version `i` is a keyframe when `i % VERSION_KEYFRAME_INTERVAL === 0`,
 * otherwise a delta against version `i - 1`. It is the single place to
 * tune that cadence. A smaller value bounds the corruption blast-radius (a
 * broken delta only invalidates entries up to the next keyframe, where the chain
 * resyncs) at the cost of more full copies on disk; a larger value saves disk at
 * the cost of a wider blast-radius. Must be a positive integer.
 */
export const VERSION_KEYFRAME_INTERVAL: number = 25;

/**
 * The language code used as the universal fallback. Every key is guaranteed to
 * exist in this catalog, so a missing translation in another language resolves
 * to the English string rather than a raw key.
 */
export const FALLBACK_LANGUAGE: string = 'en';

/**
 * The localStorage key Obsidian writes the selected UI language into. Reading it
 * is the documented community approach to follow Obsidian's own language without
 * a public i18n API.
 */
export const LANGUAGE_STORAGE_KEY: string = 'language';

/**
 * The full set of UI language codes Obsidian ships, taken verbatim from the
 * official obsidian-translations catalog (the values Obsidian writes into the
 * `language` localStorage key). Every code is supported by this plugin: a code
 * with its own bundled catalog resolves to that catalog, and every other code
 * resolves through the English fallback (see {@link FALLBACK_LANGUAGE}), so the
 * plugin never surfaces a raw key or an error for any Obsidian language.
 *
 * This array may lag behind Obsidian releases that add a new language. The lag
 * is accepted: a missing code still resolves through English and never surfaces
 * a raw key. Update trigger: a new Obsidian release adds a code not listed here
 * and a user reports the missing catalog. Update process: add the new code to
 * this array, add a matching `lang/<code>.json` file (or rely on English
 * fallback), and verify with the catalog-parity test.
 */
export const OBSIDIAN_LANGUAGES: readonly string[] = [
  'en',
  'af',
  'am',
  'ar',
  'az',
  'be',
  'bg',
  'bn',
  'ca',
  'cs',
  'da',
  'de',
  'dv',
  'el',
  'en-GB',
  'eo',
  'es',
  'eu',
  'fa',
  'fi',
  'fr',
  'ga',
  'gl',
  'he',
  'hi',
  'hr',
  'hu',
  'id',
  'it',
  'ja',
  'ka',
  'kh',
  'kn',
  'ko',
  'ky',
  'la',
  'lt',
  'lv',
  'ml',
  'ms',
  'nan-TW',
  'ne',
  'nl',
  'nn',
  'no',
  'oc',
  'or',
  'pl',
  'pt',
  'pt-BR',
  'ro',
  'ru',
  'sa',
  'si',
  'sk',
  'sl',
  'sq',
  'sr',
  'sv',
  'sw',
  'ta',
  'te',
  'th',
  'tl',
  'tr',
  'tt',
  'uk',
  'ur',
  'uz',
  'vi',
  'zh',
  'zh-TW',
];

/**
 * Combined character-length threshold for the two sides of a word diff. When
 * `oldText.length + newText.length` exceeds this value, `WordDiffHelper.segments`
 * short-circuits and returns one removed segment plus one added segment without
 * calling `Diff.diffWords`. The O(n*m) diff algorithm causes visible UI stutter on
 * very long lines (minified JS, base64 blobs); this guard keeps the modal
 * responsive while still word-diffing typical prose and code lines well under the
 * limit. 5000 characters was chosen as the threshold: it comfortably covers lines
 * up to ~2500 chars on each side (far beyond any human-readable line) and keeps
 * worst-case diff work bounded.
 */
export const WORD_DIFF_LENGTH_THRESHOLD: number = 5000;

/**
 * Maximum number of lines in a removed block (or an added block) for which
 * `WordDiffHelper.lines` uses similarity-based greedy pairing instead of falling
 * back to positional pairing. When either block exceeds this size the O(n*m)
 * similarity scoring is skipped and lines are paired by array position, the same
 * behaviour as before the fix. 20 lines covers typical prose and code edits
 * while keeping worst-case pairing work bounded at 400 comparisons.
 */
export const WORD_DIFF_PAIRING_THRESHOLD: number = 20;

/**
 * Matches a `{name}` placeholder inside a translated string. The captured group
 * is the variable name looked up in the interpolation vars.
 */
export const PLACEHOLDER_PATTERN: RegExp = /\{(\w+)}/g;
