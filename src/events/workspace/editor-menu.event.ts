import { ObsidianEvent } from '@/consts';
import { Inject } from '@/decorators/inject.decorator';
import { BaseEvent } from '@/events/base.event';
import * as MenuHelper from '@/helpers/menu.helper';
import type { ModalsService } from '@/services/modals.service';
import { TOKENS } from '@/services/tokens';
import { type ObsidianEventName } from '@/types';
import type { Editor, MarkdownView, Menu, MenuItem } from 'obsidian';

/**
 * Event handler for Obsidian's editor menu event.
 *
 * Adds a "Local history" PhpStorm-style submenu to the editor's
 * context menu with five entries:
 *
 * 1. Show History: opens the full history modal (rail visible).
 * 2. Show History for Selection: opens the modal pre-filtered to versions where
 *    the editor selection was added or removed at that point on the timeline.
 *    With an empty selection ModalsService.diffForSelection falls back to the
 *    plain Show History modal, so the entry is always live and never a
 *    dead handler.
 * 3. Put label: prompts for a label and captures a pinned labeled version of
 *    the active file's current content via VersionActionsService.
 * 4. Recent changes: reveals the file-scoped right-sidebar Recent changes panel.
 * 5. Vault changes: reveals the vault-wide changes panel.
 *
 * The "Show changes" gutter toggle lives in the viewport (gutter) menu and is
 * intentionally NOT mirrored here: scope is the editor context menu only.
 *
 * Submenu titles resolve through `plugin.t('menu.local-history.*')` against
 * every bundled catalog; a non-English catalog without a translation
 * falls back to the English string via the i18n service's standard fallback
 * so the parity guard stays intact and no surface degrades to a raw key.
 *
 * @extends {BaseEvent}
 */
export class WorkspaceEditorMenuEvent extends BaseEvent {
  /**
   * The name of the Obsidian event to handle.
   * Set to the workspace.editorMenu event.
   */
  public name: ObsidianEventName = ObsidianEvent.workspace.editorMenu;

  @Inject(TOKENS.modals)
  protected modalService!: ModalsService;

  /**
   * Handles the editor menu event by adding the "Local history" parent item
   * whose submenu carries the four PhpStorm-style entries.
   *
   * @param {Menu} menu - The menu to add items to
   * @param {Editor} editor - The active editor (used for the current selection)
   * @param {MarkdownView} _view - The Markdown view (not used in this handler)
   */
  public handler(menu: Menu, editor: Editor, _view: MarkdownView): void {
    menu.addItem((parent: MenuItem): void => {
      parent
        .setTitle(this.plugin.t('menu.local-history'))
        .setIcon('file-diff');

      const submenu: Menu = MenuHelper.setSubmenu(parent);

      submenu.addItem((item: MenuItem): void => {
        item
          .setTitle(this.plugin.t('menu.local-history.show-history'))
          .setIcon('history')
          .onClick((): void => {
            this.modalService.diff();
          });
      });

      const selection: string = editor.getSelection();

      submenu.addItem((item: MenuItem): void => {
        item
          .setTitle(this.plugin.t('menu.local-history.show-history-selection'))
          .setIcon('text-select')
          .onClick((): void => {
            /**
             * ModalsService.diffForSelection gracefully falls back to plain
             * Show History when the selection is empty or whitespace, so the
             * entry stays live even with no selection rather than being a dead
             * row.
             */
            this.modalService.diffForSelection(null, selection);
          });
      });

      submenu.addItem((item: MenuItem): void => {
        item
          .setTitle(this.plugin.t('menu.local-history.put-label'))
          .setIcon('tag')
          .onClick((): void => {
            void this.modalService.putLabel();
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

      submenu.addItem((item: MenuItem): void => {
        item
          .setTitle(this.plugin.t('view.vault-changes.title'))
          .setIcon('folder-git-2')
          .onClick((): void => {
            void this.plugin.revealVaultChanges();
          });
      });
    });
  };
}
