import { ObsidianEvent } from '@/consts';
import { Inject } from '@/decorators/inject.decorator';
import { BaseEvent } from '@/events/base.event';
import { MenuHelper } from '@/helpers/menu.helper';
import type { ModalsService } from '@/services/modals.service';
import { TOKENS } from '@/services/tokens';
import type { ObsidianEventName } from '@/types';
import { type Menu, type MenuItem, type TAbstractFile, TFile, TFolder, type WorkspaceLeaf } from 'obsidian';
import { Notice } from 'obsidian';

/**
 * Event handler for Obsidian's file-menu event in the file explorer.
 *
 * Mirrors the editor context menu's PhpStorm-style submenu (epic 04 D2) on
 * vault entries, per D11/T07:
 *
 * - On a `TFile`, the parent "Local history" expands to three entries: Show
 *   History (opens the diff modal via ModalsService.diff), Put label (prompts
 *   for a label via ModalsService.putLabel), and Recent changes (reveals the
 *   right-sidebar panel via plugin.revealRecentChanges).
 * - On a `TFolder`, the parent expands to two entries: Show History (opens
 *   the folder history modal via ModalsService.openFolderHistory, a safe
 *   placeholder until T12 lands) and Recent changes. Put label is omitted on
 *   folders: a folder has no captured content of its own, so the label entry
 *   has no defined target (D11).
 * - Any other `TAbstractFile` (neither file nor folder) short-circuits before
 *   the parent item is added, so the menu surface is unchanged.
 *
 * "Show History for Selection" from the editor submenu is deliberately
 * dropped on this surface: the file explorer has no editor selection (D11).
 *
 * The submenu titles resolve through `plugin.t('menu.local-history.*')` keys
 * that already exist in the en catalog from epic 04 T14; T15 of this epic
 * will swap any new inline strings introduced here onto the same lookup.
 *
 * @extends {BaseEvent}
 */
export class WorkspaceFilesMenuEvent extends BaseEvent {
  /**
   * Service for managing modal dialogs.
   * Injected using the @Inject decorator.
   */
  @Inject(TOKENS.modals)
  protected modalService: ModalsService;

  /**
   * The name of the Obsidian event to handle.
   * Set to the workspace.fileMenu event.
   */
  public name: ObsidianEventName = ObsidianEvent.workspace.fileMenu;

  /**
   * Handles the file-menu event by adding the "Local history" parent and
   * routing its submenu to the right entry list for files vs folders.
   *
   * @param {Menu} menu - The menu to add items to
   * @param {TAbstractFile} file - The vault entry the menu was opened for
   * @param {string} _source - The source of the menu event (not used)
   * @param {WorkspaceLeaf} _leaf - The workspace leaf (not used)
   */
  public handler(menu: Menu, file: TAbstractFile, _source: string, _leaf?: WorkspaceLeaf): void {
    if (!(file instanceof TFile) && !(file instanceof TFolder)) {
      return;
    }

    menu.addItem((parent: MenuItem): void => {
      parent
        .setTitle(this.plugin.t('menu.local-history'))
        .setIcon('file-diff');

      const submenu: Menu = MenuHelper.setSubmenu(parent);

      if (file instanceof TFile) {
        this.buildFileSubmenu(submenu, file);

        return;
      }

      this.buildFolderSubmenu(submenu, file);
    });
  };

  /**
   * Fills the submenu for a TFile target with Show History, Put label, and
   * Recent changes (D11). Show History falls back to a "no saved history"
   * notice when no snapshot exists, matching the previous flat-entry
   * behaviour so an untracked file never silently no-ops.
   *
   * @param {Menu} submenu - The submenu to populate
   * @param {TFile} file - The file the menu was opened for
   */
  protected buildFileSubmenu(submenu: Menu, file: TFile): void {
    submenu.addItem((item: MenuItem): void => {
      item
        .setTitle(this.plugin.t('menu.local-history.show-history'))
        .setIcon('history')
        .onClick((): void => {
          if (!this.modalService.diff(file)) {
            new Notice(this.plugin.t('notice.no-saved-history'));
          }
        });
    });

    submenu.addItem((item: MenuItem): void => {
      item
        .setTitle(this.plugin.t('menu.local-history.put-label'))
        .setIcon('tag')
        .onClick((): void => {
          void this.modalService.putLabel(file);
        });
    });

    submenu.addItem((item: MenuItem): void => {
      item
        .setTitle(this.plugin.t('menu.local-history.recent-changes'))
        .setIcon('clock')
        .onClick((): void => {
          void this.plugin.revealRecentChanges();
        });
    });
  }

  /**
   * Fills the submenu for a TFolder target with Show History and Recent
   * changes (D11). Show History delegates to ModalsService.openFolderHistory,
   * which is a safe placeholder until T12 wires the real FolderHistoryModal:
   * today it surfaces a "no folder history yet" notice and returns false.
   *
   * @param {Menu} submenu - The submenu to populate
   * @param {TFolder} folder - The folder the menu was opened for
   */
  protected buildFolderSubmenu(submenu: Menu, folder: TFolder): void {
    submenu.addItem((item: MenuItem): void => {
      item
        .setTitle(this.plugin.t('menu.local-history.show-history'))
        .setIcon('history')
        .onClick((): void => {
          this.modalService.openFolderHistory(folder);
        });
    });

    submenu.addItem((item: MenuItem): void => {
      item
        .setTitle(this.plugin.t('menu.local-history.recent-changes'))
        .setIcon('clock')
        .onClick((): void => {
          void this.plugin.revealRecentChanges();
        });
    });
  }
}
