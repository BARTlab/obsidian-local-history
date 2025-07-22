import { ObsidianEvent } from '@/consts';
import { Inject } from '@/decorators/inject.decorator';
import { BaseEvent } from '@/events/base.event';
import type { ModalsService } from '@/services/modals.service';
import { type ObsidianEventName } from '@/types';
import type { Editor, MarkdownView, Menu, MenuItem } from 'obsidian';

/**
 * Event handler for Obsidian's editor menu event.
 * Adds a "Local history" menu item to the editor's context menu.
 * Provides quick access to the file's change history through the context menu.
 *
 * @extends {BaseEvent}
 */
export class WorkspaceEditorMenuEvent extends BaseEvent {
  /**
   * Service for managing modal dialogs.
   * Injected using the @Inject decorator.
   */
  @Inject('ModalsService')
  protected modalService: ModalsService;

  /**
   * The name of the Obsidian event to handle.
   * Set to the workspace.editorMenu event.
   */
  public name: ObsidianEventName = ObsidianEvent.workspace.editorMenu;

  /**
   * Handles the editor menu event by adding a custom menu item.
   * Adds a "Local history" item that opens the diff modal when clicked.
   *
   * @param {Menu} menu - The menu to add items to
   * @param {Editor} _editor - The editor instance (not used in this handler)
   * @param {MarkdownView} _view - The Markdown view (not used in this handler)
   */
  public handler(menu: Menu, _editor: Editor, _view: MarkdownView): void {
    menu.addItem((item: MenuItem): void => {
      item
        .setTitle('Local history')
        .setIcon('file-diff')
        .onClick((): void => {
          this.modalService.diff();
        });
    });
  };
}
