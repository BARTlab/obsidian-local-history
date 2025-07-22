import { PluginEvent, STATUSBAR_ITEM_ID } from '@/consts';
import { Inject } from '@/decorators/inject.decorator';
import { On } from '@/decorators/on.decorator';
import type LineChangeTrackerPlugin from '@/main';
import type { ModalsService } from '@/services/modals.service';
import type { SnapshotsService } from '@/services/snapshots.service';
import type { FileSnapshot } from '@/snapshots/file.snapshot';
import type { Service, StatusBarItemCreate } from '@/types';
import { MarkdownView, type View } from 'obsidian';

/**
 * Service responsible for managing status bar items in the plugin.
 * Provides methods to display, update, and manage status bar information
 * about line changes in the current file.
 *
 * @implements {Service}
 */
export class StatusbarService implements Service {
  /**
   * Service for managing modal dialogs.
   * Injected using the @Inject decorator.
   */
  @Inject('ModalsService')
  protected modalService: ModalsService;

  /**
   * Service for managing file snapshots.
   * Injected using the @Inject decorator.
   */
  @Inject('SnapshotsService')
  protected snapshotsService: SnapshotsService;

  /**
   * Map of status bar item IDs to their corresponding HTML elements.
   * Used to track and manage status bar items.
   */
  protected items: Map<string, HTMLElement> = new Map();

  /**
   * Creates a new instance of StatusbarService.
   *
   * @param {LineChangeTrackerPlugin} plugin - The plugin instance
   */
  public constructor(
    protected plugin: LineChangeTrackerPlugin,
  ) {
  }

  /**
   * Initializes the service by creating a status bar item.
   * Creates a clickable status bar item that opens the diff modal when clicked.
   * Called during plugin initialization.
   */
  public init(): void {
    this.add({
      clickable: true,
      onClick: (): void => {
        this.modalService.diff();
      }
    });
  }

  /**
   * Updates the status bar with information about line changes in the current file.
   * Triggered when snapshots are updated via the @On decorator.
   * Displays the number of changed lines or clears the status bar if no valid snapshot exists.
   */
  @On(PluginEvent.snapshotsUpdate)
  public updateFileStatus(): void {
    const view: View = this.plugin.app.workspace.getMostRecentLeaf()?.view;
    const snapshot: FileSnapshot = this.snapshotsService.getOne();

    if (!view || !(view instanceof MarkdownView) || !snapshot) {
      this.clear();

      return;
    }

    this.update(`${snapshot.getChangesLinesCount() ?? 0} lines changed`);
  }

  /**
   * Clears a status bar item by hiding it and removing its text.
   * If no ID is provided, use the default status bar item ID.
   *
   * @param {string} id - The ID of the status bar item to clear, or undefined to use the default
   */
  public clear(id?: string): void {
    const item: HTMLElement = this.get(id);

    if (!item) {
      return;
    }

    item.hide();
    item.setText('');
  }

  /**
   * Updates the text of a status bar item and makes it visible.
   * If no ID is provided, use the default status bar item ID.
   *
   * @param {string} title - The text to display in the status bar item
   * @param {string} id - The ID of the status bar item to update, or undefined to use the default
   */
  public update(title: string, id?: string): void {
    const item: HTMLElement = this.get(id);

    if (!item) {
      return;
    }

    item.setText(title);
    item.show();
  }

  /**
   * Gets a status bar item by its ID.
   * If no ID is provided, use the default status bar item ID.
   *
   * @param {string} id - The ID of the status bar item to get, or undefined to use the default
   * @return {HTMLElement|null} The HTML element for the status bar item, or null if not found
   */
  public get(id?: string): HTMLElement | null {
    return this.items.get(id || STATUSBAR_ITEM_ID) ?? null;
  }

  /**
   * Adds a new status bar item to the Obsidian interface.
   * If an item with the same ID already exists, returns the existing item.
   * Configure the item with optional click behavior and styling.
   *
   * @param {StatusBarItemCreate} options - Configuration options for the status bar item
   * @return {HTMLElement} The HTML element for the status bar item
   */
  public add(options?: StatusBarItemCreate): HTMLElement {
    const id: string = options?.id || STATUSBAR_ITEM_ID;
    const exists: HTMLElement = this.items.get(id);

    if (exists) {
      return exists;
    }

    const item: HTMLElement = this.plugin.addStatusBarItem();

    this.items.set(id, item);

    if (options?.clickable) {
      item.addClass('mod-clickable');
    }

    if (options?.onClick) {
      item.onClickEvent(
        function(this: HTMLElement, event: MouseEvent): void {
          options.onClick(this, event);
        },
        options.onClickOptions || false
      );
    }

    return item;
  }
}
