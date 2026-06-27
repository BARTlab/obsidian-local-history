import type { ObsidianVaultEvent, ObsidianWorkspaceEvent } from '@/consts';
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
 * Interface defining event handlers for Obsidian workspace events.
 * Maps workspace event types to their corresponding handler function signatures.
 * Based on the official Obsidian documentation.
 */
interface ObsidianWorkspaceEventsHandles {
  [ObsidianWorkspaceEvent.activeLeafChange]: (leaf: WorkspaceLeaf | null) => void;
  [ObsidianWorkspaceEvent.layoutChange]: () => void;
  [ObsidianWorkspaceEvent.fileOpen]: (file: TFile) => void;
  [ObsidianWorkspaceEvent.editorMenu]: (menu: Menu, editor: Editor, view: MarkdownView) => void;
  /**
   * Handler for the markdown viewport context menu (the menu Obsidian opens on a
   * right click in the gutter, e.g. the line numbers, carrying the view toggles
   * like "Readable line length"). Undocumented event; the args mirror Obsidian's
   * own `trigger("markdown-viewport-menu", menu, view, mode, source)`.
   */
  [ObsidianWorkspaceEvent.viewportMenu]: (menu: Menu, view: MarkdownView, mode: string, source: string) => void;
  [ObsidianWorkspaceEvent.fileMenu]: (menu: Menu, files: TAbstractFile, source: string, leaf?: WorkspaceLeaf) => void;
  [ObsidianWorkspaceEvent.quit]: (tasks: Tasks) => void;
  [ObsidianWorkspaceEvent.resize]: () => void;
  [ObsidianWorkspaceEvent.cssChange]: () => void;
  [ObsidianWorkspaceEvent.editorChange]: (editor: Editor, view: MarkdownView) => void;
  [ObsidianWorkspaceEvent.editorPaste]: (evt: ClipboardEvent, editor: Editor, view: MarkdownView) => void;
  [ObsidianWorkspaceEvent.editorDrop]: (evt: DragEvent, editor: Editor, view: MarkdownView) => void;
  [ObsidianWorkspaceEvent.windowOpen]: (workspaceWindow: WorkspaceWindow, window: Window) => void;
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
 * Configuration interface for creating status bar items.
 * Defines optional properties for customizing status bar item behavior and appearance.
 */
export interface StatusBarItemCreate {
  id?: string;
  clickable?: boolean;
  onClick?: (element: HTMLElement, event: MouseEvent) => unknown;
  onClickOptions?: AddEventListenerOptions;
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
 * One row in Obsidian's native file explorer, as exposed on the undocumented
 * `view.fileItems` map keyed by vault-relative path. `selfEl` is the row's
 * outer `.nav-file-title` / `.nav-folder-title` element the decorator tints, and
 * `titleEl` is the inner label node. Both are optional because these are core
 * internals that may move across versions, so every access stays defensive and
 * the decorator degrades silently when a member is missing.
 */
export interface NativeFileExplorerItem {
  /**
   * The row's outer title element (`.nav-file-title` / `.nav-folder-title`),
   * the node the `lct-tree-*` status class is added to and removed from.
   */
  selfEl?: HTMLElement;
  /**
   * The inner label node inside the row, present on native rows but unused by
   * the file-row decorator (the CSS reaches the inner node by class descent).
   */
  titleEl?: HTMLElement;
}

/**
 * The undocumented shape of Obsidian's file-explorer view. `fileItems` maps
 * each vault-relative path to its rendered {@link NativeFileExplorerItem}; only
 * lazily-rendered (expanded) rows are present, so a missing entry means the row
 * is not currently in the DOM. Reached through a local augmentation here instead
 * of scattered `as any` casts; the decorator never assumes the field exists.
 */
export interface NativeFileExplorerView {
  /**
   * Map from vault-relative path to the rendered explorer row, when present.
   */
  fileItems?: Record<string, NativeFileExplorerItem | undefined>;
}

/**
 * The undocumented tab-header slice of an Obsidian `WorkspaceLeaf`.
 * `tabHeaderEl` is the `.workspace-tab-header` element rendered for the leaf in
 * its tab bar, the node the decorator tints by its open file's session status.
 * It is optional because it is a core internal that may move across versions, so
 * every access stays defensive and the decorator degrades silently when it is
 * missing. Reached through this local augmentation instead of scattered `as any`
 * casts; the decorator never assumes the field exists.
 */
export interface NativeWorkspaceLeaf extends WorkspaceLeaf {
  /**
   * The leaf's tab-header element (`.workspace-tab-header`), the node the
   * `lct-tree-*` status class is added to and removed from.
   */
  tabHeaderEl?: HTMLElement;
}
