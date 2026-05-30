import type {
  DiffOutputFormatType,
  DiffViewMode,
  FolderDeltaStatus,
  FolderTimelinePointKind,
  IndicatorType,
  KeepHistory,
  MapChangeAction,
  ObsidianVaultEvent,
  ObsidianWorkspaceEvent,
  VersionAction,
  WordDiffLineType
} from '@/consts';
import type { BaseExtension } from '@/extensions/base.extension';
import type { FileVersion } from '@/snapshots/file.version';
import type { RangeSet } from '@codemirror/state';
import type {
  BlockInfo,
  DecorationSet,
  EditorView,
  GutterMarker,
  PluginValue,
  ViewUpdate,
  WidgetType
} from '@codemirror/view';
import type { EventRef, Tasks, WorkspaceWindow } from 'obsidian';
import {
  type Editor,
  type MarkdownView,
  type Menu,
  type MenuItem,
  type TAbstractFile,
  type TFile,
  type WorkspaceLeaf
} from 'obsidian';

/**
 * Utility type that extracts keys from type T where the value matches the specified Value type.
 * @template T - The object type to extract keys from
 * @template Value - The value type to match against
 */
export type KeysMatching<T, Value> = {
  [K in keyof T]: T[K] extends Value ? K : never
}[keyof T];

/**
 * Type definition for a change handler function that responds to data structure modifications.
 * @template K - The key type
 * @template V - The value type
 * @param action - The type of action performed (set, delete, clear, or update)
 * @param key - Optional key that was affected by the action
 * @param value - Optional value associated with the action
 */
export type ChangeHandler<K, V> = (action: MapChangeAction, key?: K, value?: V) => void;

/**
 * Configuration interface for the Line Change Tracker plugin settings.
 * Defines all customizable options for tracking and displaying line changes.
 */
export interface LineChangeTrackerSettings {
  /**
   * Configuration for which types of changes to show
   */
  show: {
    /**
     * Whether to show changed lines
     */
    changed: boolean;
    /**
     * Whether to show restored lines
     */
    restored: boolean;
    /**
     * Whether to show added lines
     */
    added: boolean;
    /**
     * Whether to show removed lines
     */
    removed: boolean;
  };

  /**
   * Configuration for line appearance
   */
  line: {
    /**
     * Width of the change indicator line in pixels
     */
    width: number;
  };

  /**
   * Configuration for gutter colors
   */
  gutter: {
    /**
     * Color for restored lines
     */
    restored: string;
    /**
     * Color for changed lines
     */
    changed: string;
    /**
     * Color for added lines
     */
    added: string;
    /**
     * Color for removed lines
     */
    removed: string;
  };

  /**
   * Configuration for on-disk history retention caps
   */
  retention: {
    /**
     * Maximum number of file histories kept on disk (size cap, 0 disables)
     */
    maxEntries: number;
    /**
     * Maximum age in days for a persisted history (age cap, 0 disables)
     */
    maxAgeDays: number;
    /**
     * Maximum number of tombstone (deleted-file) histories kept on disk (size cap, 0 disables)
     */
    maxDeletedEntries: number;
    /**
     * Maximum age in days for a persisted tombstone history (age cap, 0 disables)
     */
    maxDeletedAgeDays: number;
  };

  /**
   * Configuration for periodic intermediate snapshots (the timeline)
   */
  snapshots: {
    /**
     * Whether to capture intermediate versions while editing
     */
    enabled: boolean;
    /**
     * Minimum time (ms) between captured versions (0 disables the time gate)
     */
    intervalMs: number;
    /**
     * Minimum number of edits between captured versions (0 disables it)
     */
    editThreshold: number;
    /**
     * Maximum number of intermediate versions kept per file (count cap, oldest evicted, 0 disables)
     */
    maxVersions: number;
    /**
     * Maximum age in days for an intermediate version (age cap, oldest evicted, 0 disables)
     */
    maxVersionAgeDays: number;
  };

  /**
   * Type of indicator to use for showing changes
   */
  type: IndicatorType;
  /**
   * History retention policy
   */
  keep: KeepHistory;
  /**
   * Persist history to disk so it survives an app restart
   */
  persist: boolean;
  /**
   * File extensions that are allowed for tracking (comma-separated)
   */
  allowedExtensions: string;
  /**
   * Path/glob patterns to exclude from tracking (comma- or newline-separated)
   */
  excludePaths: string;
  /**
   * Whether to ignore newly created files
   */
  ignoreNewFiles: boolean;
}

/**
 * Type definition for a function that takes no parameters and returns void.
 * Commonly used for callback functions and event handlers.
 */
export type FunctionVoid = () => void;

/**
 * A single language catalog: a flat map from a dotted translation key to its
 * user-facing string for one language.
 */
export type TranslationCatalog = Record<string, string>;

/**
 * All translation catalogs keyed by language code (for example `en`, `ru`). The
 * `en` catalog is the universal fallback every key is guaranteed to exist in.
 */
export type TranslationCatalogs = Record<string, TranslationCatalog>;

/**
 * Values substituted into `{name}` placeholders when translating a string. Each
 * key matches a placeholder name; numbers are stringified on interpolation.
 */
export type TranslationVars = Record<string, string | number>;

/**
 * Callback that reverts the single changed block sitting at a given 0-based
 * current line back to the base. Wired from the gutter revert affordance to the
 * snapshots service so the marker stays free of revert plumbing.
 */
export type RevertLine = (line: number) => void;

/**
 * Interface for elements that can trigger events and manage event listeners.
 * Provides methods for subscribing to and unsubscribing from events.
 */
export interface EventTriggerElement {
  /**
   * Subscribes to an event.
   * @param args - Event subscription arguments
   * @returns EventRef - Reference to the event subscription for cleanup
   */
  on(...args: unknown[]): EventRef;

  /**
   * Unsubscribes from an event.
   * @param args - Event unsubscription arguments
   */
  off(...args: unknown[]): void;
}

/**
 * Interface defining event handlers for Obsidian vault events.
 * Maps vault event types to their corresponding handler function signatures.
 */
export interface ObsidianVaultEventsHandles {
  /**
   * Handler for file creation events
   */
  [ObsidianVaultEvent.create]: (file: TAbstractFile) => void;
  /**
   * Handler for file modification events
   */
  [ObsidianVaultEvent.modify]: (file: TAbstractFile) => void;
  /**
   * Handler for file deletion events
   */
  [ObsidianVaultEvent.delete]: (file: TAbstractFile) => void;
  /**
   * Handler for file rename events
   */
  [ObsidianVaultEvent.rename]: (file: TAbstractFile, oldPath: string) => void;
}

/**
 * Interface defining event handlers for Obsidian workspace events.
 * Maps workspace event types to their corresponding handler function signatures.
 * Based on the official Obsidian documentation.
 */
export interface ObsidianWorkspaceEventsHandles {
  /**
   * Handler for active leaf change events
   */
  [ObsidianWorkspaceEvent.activeLeafChange]: (leaf: WorkspaceLeaf | null) => void;
  /**
   * Handler for layout change events
   */
  [ObsidianWorkspaceEvent.layoutChange]: () => void;
  /**
   * Handler for file open events
   */
  [ObsidianWorkspaceEvent.fileOpen]: (file: TFile) => void;
  /**
   * Handler for editor context menu events
   */
  [ObsidianWorkspaceEvent.editorMenu]: (menu: Menu, editor: Editor, view: MarkdownView) => void;
  /**
   * Handler for the markdown viewport context menu (the menu Obsidian opens on a
   * right click in the gutter, e.g. the line numbers, carrying the view toggles
   * like "Readable line length"). Undocumented event; the args mirror Obsidian's
   * own `trigger("markdown-viewport-menu", menu, view, mode, source)`.
   */
  [ObsidianWorkspaceEvent.viewportMenu]: (menu: Menu, view: MarkdownView, mode: string, source: string) => void;
  /**
   * Handler for file context menu events
   */
  [ObsidianWorkspaceEvent.fileMenu]: (menu: Menu, files: TAbstractFile, source: string, leaf?: WorkspaceLeaf) => void;
  /**
   * Handler for application quit events
   */
  [ObsidianWorkspaceEvent.quit]: (tasks: Tasks) => void;
  /**
   * Handler for window resize events
   */
  [ObsidianWorkspaceEvent.resize]: () => void;
  /**
   * Handler for CSS change events
   */
  [ObsidianWorkspaceEvent.cssChange]: () => void;
  /**
   * Handler for editor content change events
   */
  [ObsidianWorkspaceEvent.editorChange]: (editor: Editor, view: MarkdownView) => void;
  /**
   * Handler for editor paste events
   */
  [ObsidianWorkspaceEvent.editorPaste]: (evt: ClipboardEvent, editor: Editor, view: MarkdownView) => void;
  /**
   * Handler for editor drop events
   */
  [ObsidianWorkspaceEvent.editorDrop]: (evt: DragEvent, editor: Editor, view: MarkdownView) => void;
  /**
   * Handler for window open events
   */
  [ObsidianWorkspaceEvent.windowOpen]: (workspaceWindow: WorkspaceWindow, window: Window) => void;
  /**
   * Handler for window close events
   */
  [ObsidianWorkspaceEvent.windowClose]: (workspaceWindow: WorkspaceWindow, window: Window) => void;
}

/**
 * Union type of all possible Obsidian event names.
 * Combines workspace and vault event names into a single type.
 */
export type ObsidianEventName = `${ObsidianWorkspaceEvent}` | `${ObsidianVaultEvent}`;

/**
 * Utility type that extracts the parameter types for a specific workspace event handler.
 * @template T - The workspace event type
 */
export type WorkspaceEventArgs<T extends ObsidianWorkspaceEvent> = Parameters<ObsidianWorkspaceEventsHandles[T]>;

/**
 * Utility type that extracts the parameter types for a specific vault event handler.
 * @template T - The vault event type
 */
export type VaultEventArgs<T extends ObsidianVaultEvent> = Parameters<ObsidianVaultEventsHandles[T]>;

/**
 * Configuration interface for creating status bar items.
 * Defines optional properties for customizing status bar item behavior and appearance.
 */
export interface StatusBarItemCreate {
  /**
   * Optional unique identifier for the status bar item
   */
  id?: string;
  /**
   * Whether the status bar item should be clickable
   */
  clickable?: boolean;
  /**
   * Click event handler for the status bar item
   */
  onClick?: (element: HTMLElement, event: MouseEvent) => unknown;
  /**
   * Options for the click event listener
   */
  onClickOptions?: AddEventListenerOptions;
}

/**
 * Type definition for abstract class constructors.
 * @template T - The type that the constructor creates (defaults to empty object)
 */
export type AbstractConstructor<T = {}> = abstract new (...args: unknown[]) => T;

/**
 * Type definition for concrete class constructors.
 * @template T - The type that the constructor creates (defaults to empty object)
 */
export type ClassConstructor<T = {}> = {
  new(...args: unknown[]): T;
};

/**
 * Interface for CodeMirror editor extensions used in the plugin.
 * Extends both PluginValue and BaseExtension to provide editor functionality.
 */
export interface EditorExtension extends PluginValue, BaseExtension {
  /**
   * Optional decoration set for visual indicators
   */
  decorations?: DecorationSet;
}

/**
 * Base interface for plugin services.
 * Defines optional lifecycle methods that services can implement.
 */
export interface Service {
  /**
   * Optional initialization method called during service setup
   */
  init?(): void | Promise<void>;

  /**
   * Optional load method called when the service should start
   */
  load?(): void | Promise<void>;

  /**
   * Optional unload method called when the service should stop
   */
  unload?(): void | Promise<void>;
}

/**
 * Type definition for class-based providers.
 * @template T - The type that the class constructor creates
 */
export type ClassProvider<T> = new (...args: unknown[]) => T;

/**
 * Type definition for value-based providers.
 * @template T - The type of the provided value
 */
export type ValueProvider<T> = T;

/**
 * Union type for dependency injection providers.
 * Can be either a class constructor or a direct value.
 * @template T - The type being provided
 */
export type Provider<T> = ClassProvider<T> | ValueProvider<T>;

/**
 * Utility type for accessing deeply nested object properties using dot notation paths.
 * @template T - The object type to traverse
 * @template Path - The dot-separated path string (e.g., "user.profile.name")
 */
export type DeepValue<T, Path extends string> =
  Path extends `${infer Key}.${infer Rest}`
    ? Key extends keyof T
      ? DeepValue<T[Key], Rest>
      : never
    : Path extends keyof T
      ? T[Path]
      : never;

/**
 * Union type representing all primitive JavaScript types.
 * Used to determine when to stop recursion in type utilities.
 */
export type Primitive = string | number | boolean | null | undefined | symbol | bigint;

/**
 * Utility type for joining path segments with dots.
 * @template Prefix - The prefix path segment
 * @template Key - The key to append to the path
 */
export type PathJoin<Prefix extends string, Key extends string> =
  Prefix extends '' ? Key : `${Prefix}.${Key}`;

/**
 * Utility type that recursively collects all possible dot-notation paths in an object.
 * Generates paths like "a.b.c" for nested object properties.
 * @template T - The object type to generate paths for
 * @template Prefix - The current path prefix (used internally for recursion)
 */
export type PathTo<T, Prefix extends string = ''> = {
  [K in keyof T & string]:
  T[K] extends Primitive
    ? PathJoin<Prefix, K>
    : PathTo<T[K], PathJoin<Prefix, K>>
}[keyof T & string];

/**
 * Utility type that extracts the value type at a specific dot-notation path.
 * @template T - The object type to extract from
 * @template Path - The dot-separated path string
 */
export type PathValue<T, Path extends string> =
  Path extends `${infer Key}.${infer Rest}`
    ? Key extends keyof T
      ? PathValue<T[Key], Rest>
      : never
    : Path extends keyof T
      ? T[Path]
      : never;

/**
 * Interface for HTML elements that have scroll synchronization cleanup functionality.
 * Extends HTMLElement to include the _scrollSyncCleanup method.
 */
export interface HTMLElementWithScrollSync extends HTMLElement {
  _scrollSyncCleanup?: () => void;
}

/**
 * Configuration object for creating DOM elements with DomHelper.
 */
export interface DomElementConfig extends DomUpdateConfig {
  /**
   * The tag name of the element to create
   */
  tag: keyof HTMLElementTagNameMap;
  /**
   * Optional container to append the element to
   */
  container?: HTMLElement;
}

/**
 * Represents the configuration for updating DOM element class attributes.
 * - `add` specifies the classes to be added.
 * - `remove` specifies the classes to be removed.
 */
export interface DomUpdateConfigClasses {
  add?: string | string[];
  remove?: string | string[];
}

/**
 * Configuration object for updating DOM elements with DomHelper.
 */
export interface DomUpdateConfig {
  /**
   * CSS classes for the element
   */
  classes?: string | string[] | DomUpdateConfigClasses;
  /**
   * Text content for the element
   */
  text?: string;
  /**
   * HTML attributes to set on the element
   */
  attributes?: Record<string, string>;
  /**
   * CSS styles to apply to the element
   */
  styles?: Partial<CSSStyleDeclaration>;
  /**
   * Event listeners to attach to the element
   */
  events?: Record<string, (event: Event) => void>;
  /**
   * Child elements to append
   */
  children?: DomElementConfig[];
  /**
   * HTML content for the element
   */
  html?: string;
}

/**
 * Serialized form of a single TrackerLine, persisted to disk and restored on
 * load. Only the fields needed to rebuild the line's state are stored; the id
 * is intentionally omitted so a fresh, collision-free id is assigned on load.
 */
export interface SerializedTrackerLine {
  originalPosition: number;
  currentPosition: number;
  removedAtPosition: number;
  changeAtPosition: number;
  contentSameOriginal: boolean;
  hash: string | null;
  original: string | null;
  current: string | null;
  removedTimeStamp: number;
  changedTimeStamp: number;
  addedTimeStamp: number;
}

/**
 * Serialized form of a single intermediate version (timeline entry). Holds the
 * captured content and its timestamp; the id is omitted so a fresh one is
 * assigned on restore. The optional `label` is the user-supplied tag that turns
 * a version into a pinned marker (exempt from dedup and eviction). The optional
 * `external` flag marks versions captured from an external-change event (D13):
 * they obey normal retention (not pinned) but get a UI badge so the user can
 * tell git-pull / sync / external-editor states apart from in-editor edits.
 * Both fields are omitted from the payload when unset so existing histories
 * round-trip unchanged.
 *
 * A version entry is keyframe-xor-delta: it carries either `lines` (a keyframe,
 * the full materialized text) or `delta` (a unified-diff string against the
 * preceding entry in the chain), never both and never neither. A current
 * `{ timestamp, lines }` entry is already a valid keyframe, so this shape is a
 * strict superset of the original full-text format (Epic 09). The `label` and
 * `external` flags apply to either form. Runtime dispatch on which form an entry
 * carries lives in the codec, not in this type.
 */
export interface SerializedFileVersion {
  timestamp: number;
  lines?: string[];
  delta?: string;
  label?: string;
  external?: boolean;
}

/**
 * Serialized form of a FileSnapshot. Holds the original baseline, the current
 * state, the full tracker, and the intermediate version timeline so highlights
 * and history can be restored verbatim after a restart. The change map is not
 * stored because it is recomputed from the tracker on load.
 *
 * Optional `deletedTimestamp` flags a tombstone snapshot (D1): the file was
 * deleted in the vault but the snapshot keeps its final state and history so the
 * file remains recoverable. Optional `movedIntoAt` flags the destination side of
 * a cross-directory move (D2): the live snapshot re-keyed to the new path
 * carries this stamp so folder views can colour it as "added in the new folder"
 * while its captured history travels with it. The fields are omitted from the
 * payload when unset so existing histories round-trip unchanged.
 */
export interface SerializedFileSnapshot {
  path: string;
  lineBreak: string;
  timestamp: number;
  lines: string[];
  state: string[];
  tracker: SerializedTrackerLine[];
  versions?: SerializedFileVersion[];
  deletedTimestamp?: number;
  movedIntoAt?: number;
}

/**
 * On-disk shape of the persisted history file. Versioned so the format can
 * evolve without misreading older data.
 */
export interface SerializedHistory {
  version: number;
  snapshots: SerializedFileSnapshot[];
}

/**
 * On-disk shape of a single history shard (Epic 10): one self-describing JSON
 * file per snapshot under the {@link HISTORY_SHARD_DIR} directory, so a corrupt
 * or lost shard costs one note's history instead of the whole base. The shard
 * carries its own `version` (the on-disk format version emitted by
 * `SnapshotsService.serialize()`, not a hardcoded literal) so the version codec
 * can bump it without any shard-level change, and the embedded `snapshot.path`
 * is the read-time identity (the filename is only a hash of that path). The
 * shard is content-agnostic: it never inspects `snapshot.versions[]`, which may
 * hold full-text or delta entries depending on the codec.
 */
export interface SerializedShard {
  version: number;
  snapshot: SerializedFileSnapshot;
}

/**
 * Options that govern when an intermediate version is captured on the timeline.
 * Mirrors the user-facing `snapshots` settings and is passed to
 * FileSnapshot.captureVersion so the model stays decoupled from the settings
 * service.
 */
export interface SnapshotCaptureOptions {
  /**
   * Whether intermediate version capture is enabled at all
   */
  enabled: boolean;
  /**
   * Minimum time (ms) between captures (0 disables the time gate)
   */
  intervalMs: number;
  /**
   * Minimum number of edits between captures (0 disables the edit gate)
   */
  editThreshold: number;
  /**
   * Maximum number of versions kept (count cap, oldest evicted past this, 0 disables)
   */
  maxVersions: number;
  /**
   * Maximum age in days for a kept version (age cap, evicted first, 0 disables)
   */
  maxVersionAgeDays: number;
}

/**
 * Interface defining the parameters for creating a TrackerLine instance.
 * Used to initialize a line tracker with optional properties.
 */
export interface TrackerLineParams {
  /**
   * The content of the line as a string
   */
  content?: string;

  /**
   * The original position (line number) in the document
   */
  originalPosition?: number;

  /**
   * The current position (line number) in the document
   */
  currentPosition?: number;

  /**
   * Whether the content is the same as in the original document
   */
  contentSameOriginal?: boolean;
}

/**
 * Configuration object for ConfirmModal parameters.
 * All parameters are optional with sensible defaults.
 */
export interface ConfirmModalConfig {
  /**
   * The title of the confirmation dialog
   */
  title?: string;
  /**
   * The message content of the confirmation dialog
   */
  message?: string;
  /**
   * Text for the confirmation button (defaults to 'Confirm')
   */
  confirmText?: string;
  /**
   * Text for the cancel button (defaults to 'Cancel')
   */
  cancelText?: string;
}

/**
 * Configuration object for PromptModal parameters. A prompt asks the user for a
 * single short string (for example a custom version label) and resolves to the
 * entered text or null on cancel. All fields are optional with sensible
 * defaults so a caller can open a minimal prompt by passing an empty config.
 */
export interface PromptModalConfig {
  /**
   * The title of the prompt dialog
   */
  title?: string;
  /**
   * Optional message rendered above the input
   */
  message?: string;
  /**
   * Placeholder text shown inside the empty input
   */
  placeholder?: string;
  /**
   * Initial value pre-filled in the input
   */
  initialValue?: string;
  /**
   * Text for the confirm button (defaults to 'Confirm')
   */
  confirmText?: string;
  /**
   * Text for the cancel button (defaults to 'Cancel')
   */
  cancelText?: string;
}

/**
 * Callback fired when the user clicks a file row. The component passes the
 * vault-relative path so the parent modal can drive the diff pane.
 */
export type FolderTreeSelectionHandler = (path: string) => void;

/**
 * Internal tree node: a folder (possibly the synthetic root) or a leaf file.
 * Children of a folder are sorted alphabetically with folders before files so
 * the rendered output reads top-down like a file explorer.
 */
export interface FolderTreeNode {
  /**
   * Vault-relative path of the node (folder or file).
   */
  path: string;
  /**
   * Display name (the last path segment).
   */
  name: string;
  /**
   * Whether this node is a folder; files are leaves.
   */
  isFolder: boolean;
  /**
   * Per-file delta status; undefined for folder nodes.
   */
  status?: FolderDeltaStatus;
  /**
   * Whether the file's delta point at T is an external-change capture (T20).
   */
  external?: boolean;
  /**
   * Child nodes (folders + files) when `isFolder` is true.
   */
  children: FolderTreeNode[];
}

/**
 * Shape of a single toolbar icon button: the Lucide icon id, the label exposed
 * via tooltip and aria-label, the click handler (sync or async), and an
 * optional destructive accent for the restore-original and remove-history
 * actions.
 */
export interface ToolbarButtonConfig {
  /**
   * The Obsidian (Lucide) icon id to render
   */
  icon: string;
  /**
   * The text label exposed via tooltip and aria-label
   */
  label: string;
  /**
   * The click handler, awaited when it returns a promise
   */
  onClick: FunctionVoid | (() => Promise<void>);
  /**
   * Whether to add the destructive (error-tinted) accent
   */
  warning?: boolean;
}

/**
 * Toolbar button config used by the folder modal toolbar. Mirrors the shape the
 * file modal uses (icon id + accessible label + click handler) so both modals
 * present a consistent control surface. The `warning` flag adds the destructive
 * accent (`.lct-toolbar-warning`) for the restore-original and remove-history
 * actions, matching the file modal's classification.
 */
export interface FolderToolbarButtonConfig {
  /**
   * The Obsidian (Lucide) icon id to render
   */
  icon: string;
  /**
   * The text label exposed via tooltip and aria-label
   */
  label: string;
  /**
   * The click handler
   */
  onClick: FunctionVoid;
  /**
   * Whether to paint the destructive accent
   */
  warning?: boolean;
}

/**
 * Shape of the runtime-only `setSubmenu()` method on a `MenuItem`. The method
 * exists in Obsidian >= 1.5 but is missing from the bundled 1.13.0 typings, so
 * a structural interface keeps the cast localised to its helper instead of
 * leaking `any` to every call site that builds a submenu.
 */
export interface MenuItemWithSubmenu extends MenuItem {
  setSubmenu(): Menu;
}

/**
 * Type definition for DOM event handlers used in CodeMirror gutters.
 * Maps event names to handler functions that receive view, line, and event information.
 * Mirrors the CodeMirror gutter handler shape so this plugin can build gutter
 * configs without importing CodeMirror's internal types.
 */
export type Handlers = {
  [event: string]: (view: EditorView, line: BlockInfo, event: Event) => boolean;
};

/**
 * Gutter configuration mirrored from CodeMirror's `gutter()` options, extended
 * with this plugin's `BaseExtension` so gutter extensions can be built and
 * registered without importing CodeMirror's internal config type.
 */
export interface GutterConfig extends BaseExtension {
  /**
   An extra CSS class to be added to the wrapper (`cm-gutter`)
   element.
   */
  class?: string;
  /**
   Controls whether empty gutter elements should be rendered.
   Defaults to false.
   */
  renderEmptyElements?: boolean;
  /**
   Retrieve a set of markers to use in this gutter.
   */
  markers?: (view: EditorView) => (RangeSet<GutterMarker> | readonly RangeSet<GutterMarker>[]);
  /**
   Can be used to optionally add a single marker to every line.
   */
  lineMarker?: (view: EditorView, line: BlockInfo, otherMarkers: readonly GutterMarker[]) => GutterMarker | null;
  /**
   Associate markers with block widgets in the document.
   */
  widgetMarker?: (view: EditorView, widget: WidgetType, block: BlockInfo) => GutterMarker | null;
  /**
   If line or widget markers depend on an additional state and should
   be updated when that changes, pass a predicate here that checks
   whether a given view update might change the line markers.
   */
  lineMarkerChange?: null | ((update: ViewUpdate) => boolean);
  /**
   Add a hidden spacer element that gives the gutter its base
   width.
   */
  initialSpacer?: null | ((view: EditorView) => GutterMarker);
  /**
   Update the spacer element when the view is updated.
   */
  updateSpacer?: null | ((spacer: GutterMarker, update: ViewUpdate) => GutterMarker);
  /**
   Supply event handlers for DOM events on this gutter.
   */
  domEventHandlers?: Handlers;
}

/**
 * The normalized result of adopting a persisted history baseline and version
 * timeline. The collaborator produces defensive copies and the façade assigns
 * each field back; `versions` belongs to the timeline cluster but adoptHistory
 * sets it alongside the history baseline, so it is carried back here too.
 */
export interface AdoptHistoryResult {
  /**
   * The defensive copy of the persisted history baseline lines.
   */
  historyLines: string[];

  /**
   * The defensive copy of the persisted version timeline, oldest first.
   */
  versions: FileVersion[];
}

/**
 * The outcome of an updateState call: the normalized current state lines and the
 * hash of that state. The façade owns both `state` and `lastHash`, so the
 * collaborator returns both for the façade to write back.
 */
export interface UpdateStateResult {
  /**
   * The defensive copy of the current state as an array of lines.
   */
  state: string[];

  /**
   * The hash of the current state, used for change detection.
   */
  lastHash: string;
}

/**
 * The slice of a snapshot the base-content resolution needs, reduced to the
 * three reads the history modal performs when picking a diff base. Keeping the
 * helper to this minimal shape (instead of a full FileSnapshot) is what lets the
 * resolution stay a pure, directly unit-tested function with no Obsidian or
 * model dependency.
 */
export interface BaseContentSnapshot {
  /**
   * The captured content of the timeline versions, newest first (mirrors
   * `FileSnapshot.getVersions()` mapped through `getContent`). The first entry,
   * when present, is the latest snapshot the baseline entry diffs against.
   */
  versions: string[];
  /**
   * The file's original captured content (the birth-state fallback).
   */
  original: string;
  /**
   * Resolves a picked intermediate version's content by id, or null when the id
   * does not address an existing version (mirrors `FileSnapshot.getVersion`).
   *
   * @param {string} id - The version id to resolve
   * @return {string | null} The version content, or null when absent
   */
  versionContent(id: string): string | null;
}

/**
 * One line of an inline diff. A line is either unchanged context, a pure
 * addition, a pure removal, or a modification (a removed and added pair that
 * represent the same logical line). For a modified line both the old and the
 * new text are kept so the renderer can show word-level spans for each side.
 */
export interface InlineDiffLine {
  /**
   * The kind of change this line represents.
   */
  type: WordDiffLineType;
  /**
   * The old (base) text of the line, present for context, removed, modified.
   */
  oldText?: string;
  /**
   * The new (current) text of the line, present for context, added, modified.
   */
  newText?: string;
}

/**
 * Result of comparing a snapshot's state at a chosen timeline point T to its
 * current state (D8). `base` is the resolved content at T (an empty array means
 * "did not exist at T"); `current` is the resolved live content (an empty array
 * means "does not exist now"); `status` is the categorical diff used by the
 * folder tree colouring.
 *
 * The two content arrays are returned as plain copies so the diff renderer can
 * consume them without worrying about mutating the underlying snapshot.
 */
export interface FolderDeltaResult {
  status: FolderDeltaStatus;
  base: string[];
  current: string[];
}

/**
 * One timeline version reduced to just what the selection filter needs: its
 * stable id and its captured lines. Kept intentionally minimal (instead of
 * `FileVersion`) so the helper stays pure and directly unit-testable with no
 * Obsidian or model dependency.
 *
 * Versions are passed in the order the rail renders them; the helper itself is
 * order-agnostic and uses the explicit `baselineLines` parameter rather than an
 * out-of-band convention to anchor the oldest version's diff.
 */
export interface SelectableVersion {
  /**
   * The version's stable id, returned when its diff touches the selection.
   */
  id: string;
  /**
   * The version's captured content as lines, diffed against its neighbour.
   */
  lines: string[];
}

/**
 * The four supported diff display modes. The two {@link DiffViewMode} values
 * render the textual unified patch and the word-level inline highlights, and
 * the two {@link DiffOutputFormatType} values render the diff2html line-by-line
 * or side-by-side views.
 */
export type DiffRenderMode = DiffViewMode | DiffOutputFormatType;

/**
 * Minimal translator surface the helper needs. Matches `LineChangeTrackerPlugin.t`
 * so the modal can pass `plugin` directly, but stays narrow so a test or another
 * caller can provide its own translator without dragging in the whole plugin.
 */
export interface DiffRenderTranslator {
  t(key: string, vars?: TranslationVars): string;
}

/**
 * Parameters accepted by {@link DiffRenderHelper.render}. The renderer is pure
 * and modal-agnostic: it owns no state, holds no references, and only mutates
 * the provided container. Per-hunk revert affordances, the columns header,
 * the diff notice, and scroll synchronization stay in the calling modal because
 * they are file-mode specific (D6).
 */
export interface DiffRenderParams {
  /**
   * The selected base content split by `lineBreak`.
   */
  baseLines: string[];
  /**
   * The current state content split by `lineBreak`.
   */
  currentLines: string[];
  /**
   * The line separator used when joining content back into text for patches.
   */
  lineBreak: string;
  /**
   * Which of the four diff modes to render.
   */
  mode: DiffRenderMode;
  /**
   * The container the renderer writes the diff DOM into.
   */
  container: HTMLElement;
  /**
   * The vault-relative file path used in the unified patch headers.
   */
  filePath: string;
  /**
   * Translator used for the copy button tooltip and the copy notice text.
   */
  plugin: DiffRenderTranslator;
}

/**
 * One searchable timeline version reduced to just what the rail filter needs:
 * its stable id and its captured text. Keeping the helper to this minimal shape
 * (instead of a full FileVersion) is what lets the filter stay a pure, directly
 * unit-tested function with no Obsidian or model dependency.
 */
export interface SearchableVersion {
  /**
   * The version's stable id, returned when its content matches.
   */
  id: string;
  /**
   * The version's captured content, searched case-insensitively.
   */
  content: string;
}

/**
 * A single point in the folder timeline. `timestamp` is the moment the event
 * happened (newest-first when sorted), `path` is the snapshot's vault-relative
 * path under the folder root, `kind` is the discriminator above, and `dayKey`
 * is the localized day string (`new Date(timestamp).toLocaleDateString()`) the
 * rail uses to group rows: identical to {@link FileVersion.getDate} so the
 * folder modal rail can group rows the same way the file modal rail does.
 *
 * For a `'capture'` point, `versionId` carries the originating version's id
 * so callers can correlate the timeline entry with the underlying
 * {@link FileVersion}. For `'delete'` and `'move-in'` points, the field stays
 * `undefined` (the event is a snapshot-level marker, not tied to a version).
 */
export interface FolderTimelinePoint {
  timestamp: number;
  path: string;
  kind: FolderTimelinePointKind;
  dayKey: string;
  versionId?: string;
}

/**
 * The pure result of describing a version. Carries the discriminator plus the
 * line-level delta of the transition (number of newly added lines and number of
 * removed lines), so the UI can render "Modified (+3, -1)" inline without
 * running the diff twice.
 */
export interface VersionDescription {
  /**
   * The action discriminator for the version.
   */
  kind: VersionAction;
  /**
   * Number of lines added going from previous to current.
   */
  added: number;
  /**
   * Number of lines removed going from previous to current.
   */
  removed: number;
}

/**
 * Result of restoring a selected version. The flag tells the caller whether the
 * write happened, so a UI can refresh its diff/rail only when something actually
 * changed (a no-op restore against identical content stays silent).
 */
export interface VersionRestoreResult {
  /**
   * True when the file content was rewritten to the version.
   */
  applied: boolean;
}

/**
 * Result of removing a selected version, including the next selection id the
 * caller can fall back to so a UI list stays focused on a sensible neighbour
 * after the deletion. The id is null when the timeline is now empty.
 */
export interface VersionRemoveResult {
  /**
   * True when a version was dropped from the timeline.
   */
  removed: boolean;
  /**
   * The id the caller should select next, or null when nothing remains.
   */
  nextId: string | null;
}

/**
 * Open options for the history/diff modal. Both fields are optional, so a call
 * with no options preserves the current default behaviour: the rail is shown
 * and the modal opens on the latest captured version (D4).
 *
 * - `initialBaseId`: pre-selects a specific version id as the diff base on open
 *   (the rail entry that would otherwise be the top one). A baseline-only file
 *   ignores it; an unknown id falls through to the modal's default selection.
 * - `hideRail`: opens the modal without the left rail (search + version list),
 *   so the diff and the toolbar fill the modal. Used by the Recent changes
 *   panel, which is the navigator in that session.
 */
export interface HistoryModalOpenOptions {
  /**
   * The version id to pre-select as the diff base on open.
   */
  initialBaseId?: string;
  /**
   * Whether to hide the left rail (search + version list).
   */
  hideRail?: boolean;
  /**
   * Optional set of version ids the rail must restrict itself to: when present,
   * only versions whose id is in the set survive the rail filters. Used by
   * "Show History for Selection" (D7/T09) to narrow the rail to versions where
   * the editor selection was added or removed. `undefined` means no selection
   * filter is active (the rail behaves as before); an empty set means a filter
   * is active but matched nothing, so the rail shows its no-results hint.
   */
  selectionFilterIds?: ReadonlySet<string>;
}

/**
 * The façade-owned inputs a capture attempt operates on. Bundles the timeline
 * array, the empty-timeline dedup reference (the history baseline), the line
 * break, and the cadence/retention options so the collaborator stays a stateless
 * operator over passed-in state without a long positional parameter list.
 */
export interface VersionCaptureContext {
  /**
   * The current timeline, oldest first. The façade owns this array.
   */
  versions: FileVersion[];

  /**
   * The history baseline used as the dedup reference when the timeline is empty.
   */
  historyBaseline: string;

  /**
   * The line break used to join candidate content for comparison.
   */
  lineBreak: string;

  /**
   * The capture cadence configuration and retention caps.
   */
  options: SnapshotCaptureOptions;
}

/**
 * Outcome of a capture attempt. `version` is the freshly pushed version (or null
 * when the cadence/dedup gates skipped it), and `versions` is the timeline array
 * the façade must adopt: unchanged on a skip, or the appended-then-evicted array
 * on a capture. The façade owns the `versions` field, so the collaborator hands
 * the resulting array back rather than mutating a private copy.
 */
export interface VersionCaptureResult {
  /**
   * The version pushed onto the timeline, or null when no version was taken.
   */
  version: FileVersion | null;

  /**
   * The timeline array the façade must store after the attempt.
   */
  versions: FileVersion[];
}

/**
 * One entry handed to {@link FolderTreeComponent.update}: a vault-relative file
 * path and the per-file delta status resolved by `FolderDeltaHelper.compareAt`
 * for the selected timeline point T.
 *
 * The component only renders rows whose status is `added | modified | deleted`
 * (D9). Entries with status `'none'` are accepted to keep the call-site simple
 * (the caller can pass every snapshot in the subtree) but are filtered out
 * before rendering so the tree shows only the files that actually changed.
 */
export interface FolderTreeEntry {
  path: string;
  status: FolderDeltaStatus;
  /**
   * Optional flag set when the file's latest delta point at the picked T is an
   * external-change capture (D13, T20). The component renders a small badge on
   * the file row when true so the user can spot external states without
   * leaving the tree (AC3). The field is optional so unit tests and earlier
   * callers can keep ignoring it; the rendered tree only depends on it for the
   * badge, not for the row's visibility or its status colour token.
   */
  external?: boolean;
}

/**
 * Minimal translator surface the component needs. Matches `LineChangeTrackerPlugin.t`
 * so the modal can pass `plugin` directly, but stays narrow so unit tests can
 * supply an inert translator (echoing keys) without the real plugin instance.
 */
export interface FolderTreeTranslator {
  t(key: string, vars?: TranslationVars): string;
}

/**
 * Parameters for {@link FolderTreeComponent.update}. The component fully owns
 * the DOM under its mount container, so update is the single entry point that
 * rebuilds the tree against a fresh `(entries, rootPath)` pair while keeping
 * the user's expand/collapse state and the currently-selected file (when it is
 * still present in the new entries).
 */
export interface FolderTreeUpdateParams {
  entries: FolderTreeEntry[];
  rootPath: string;
}
