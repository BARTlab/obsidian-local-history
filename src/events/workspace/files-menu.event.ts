import { ObsidianEvent } from '@/consts';
import { Inject } from '@/decorators/inject.decorator';
import { BaseEvent } from '@/events/base.event';
import type { ModalsService } from '@/services/modals.service';
import type { ObsidianEventName } from '@/types';
import type { Menu, MenuItem, TAbstractFile, TFile, WorkspaceLeaf } from 'obsidian';
import { Notice } from 'obsidian';

/**
 * Event handler for Obsidian's file menu event.
 * Adds a "Local history" menu item to the file's context menu in the file explorer.
 * Provides quick access to the file's change history directly from the file explorer.
 *
 * @extends {BaseEvent}
 */
export class WorkspaceFilesMenuEvent extends BaseEvent {
  /**
   * Service for managing modal dialogs.
   * Injected using the @Inject decorator.
   */
  @Inject('ModalsService')
  protected modalService: ModalsService;

  /**
   * The name of the Obsidian event to handle.
   * Set to the workspace.fileMenu event.
   */
  public name: ObsidianEventName = ObsidianEvent.workspace.fileMenu;

  /**
   * Handles the file menu event by adding a custom menu item.
   * Adds a "Local history" item that opens the diff modal when clicked.
   * Shows a notice if there's no history available for the file.
   *
   * @param {Menu} menu - The menu to add items to
   * @param {TAbstractFile} file - The file the menu was opened for
   * @param {string} _source - The source of the menu event (not used in this handler)
   * @param {WorkspaceLeaf} _leaf - The workspace leaf (not used in this handler)
   */
  public handler(menu: Menu, file: TAbstractFile, _source: string, _leaf?: WorkspaceLeaf): void {
    if (!file || !(file as TFile).stat || !(file as TFile).extension || !(file as TFile).basename) {
      return;
    }

    menu.addItem((item: MenuItem): void => {
      item
        .setTitle('Local history')
        .setIcon('file-diff')
        .onClick((): void => {
          if (!this.modalService.diff(file as TFile)) {
            new Notice('There is no saved history for this file.');
          }
        });
    });
  };
}
