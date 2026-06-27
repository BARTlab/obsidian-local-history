import type { MapChangeAction } from '@/consts';
import type { BaseExtension } from '@/extensions/base.extension';
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
 * Type definition for concrete class constructors.
 * The argument list is intentionally `any[]`: under `strictFunctionTypes`
 * constructor parameters are checked contravariantly, so a marker type used
 * purely to identify a class (DI token resolution, registry keys) must accept
 * any concrete constructor signature regardless of its real parameters.
 * @template T - The type that the constructor creates (defaults to empty object)
 */
export type ClassConstructor<T = {}> = {
  new(...args: any[]): T;
};

/**
 * Interface for CodeMirror editor extensions used in the plugin.
 * Extends both PluginValue and BaseExtension to provide editor functionality.
 */
export interface EditorExtension extends PluginValue, BaseExtension {
  /** Optional decoration set for visual indicators */
  decorations?: DecorationSet;
}

/**
 * Base interface for plugin services.
 * Defines optional lifecycle methods that services can implement.
 */
export interface Service {
  /** Optional initialization method called during service setup */
  init?(): void | Promise<void>;

  /** Optional load method called when the service should start */
  load?(): void | Promise<void>;

  /** Optional unload method called when the service should stop */
  unload?(): void | Promise<void>;
}

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
type Primitive = string | number | boolean | null | undefined | symbol | bigint;

/**
 * Utility type for joining path segments with dots.
 * @template Prefix - The prefix path segment
 * @template Key - The key to append to the path
 */
type PathJoin<Prefix extends string, Key extends string> =
  Prefix extends '' ? Key : `${Prefix}.${Key}`;

/**
 * Utility type that recursively collects all possible dot-notation paths in an object.
 * Generates paths like "a.b.c" for nested object properties.
 * @template T - The object type to generate paths for
 * @template Prefix - The current path prefix (used internally for recursion)
 */
export type PathTo<T, Prefix extends string = ''> = {
  [K in keyof T & string]:
  T[K] extends Primitive | readonly unknown[]
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

/** Configuration object for creating DOM elements with DomHelper. */
export interface DomElementConfig extends DomUpdateConfig {
  /** The tag name of the element to create */
  tag: keyof HTMLElementTagNameMap;
  /** Optional container to append the element to */
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

/** Configuration object for updating DOM elements with DomHelper. */
export interface DomUpdateConfig {
  /** CSS classes for the element */
  classes?: string | string[] | DomUpdateConfigClasses;
  /** Text content for the element */
  text?: string;
  /** HTML attributes to set on the element */
  attributes?: Record<string, string>;
  /** CSS styles to apply to the element */
  styles?: Partial<CSSStyleDeclaration>;
  /** Event listeners to attach to the element */
  events?: Record<string, (event: Event) => void>;
  /** Child elements to append */
  children?: DomElementConfig[];
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
