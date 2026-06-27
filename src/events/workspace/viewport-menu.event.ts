import { ObsidianEvent } from '@/consts';
import { Inject } from '@/decorators/inject.decorator';
import { BaseEvent } from '@/events/base.event';
import type { SettingsService } from '@/services/settings.service';
import { TOKENS } from '@/services/tokens';
import { type ObsidianEventName } from '@/types';
import type { MarkdownView, Menu, MenuItem } from 'obsidian';

/**
 * Event handler for Obsidian's markdown viewport context menu: the menu opened by
 * a right click in the editor gutter (the line numbers), which carries the view
 * toggles "Readable line length", "Line numbers", and "Inline title". This is a
 * separate, undocumented event from `editor-menu` (the text context menu), so a
 * gutter-targeted toggle must be added here rather than there.
 *
 * Adds a "Show changes" toggle in the same "view" section as the native view
 * toggles, so it sits alongside them and flips all gutter change indicators on
 * or off at once (the same composite `show.*` toggle the gutter and editor menus
 * share, so they stay in sync).
 *
 * @extends {BaseEvent}
 */
export class WorkspaceViewportMenuEvent extends BaseEvent {
  @Inject(TOKENS.settings)
  protected settingsService!: SettingsService;

  /**
   * The name of the Obsidian event to handle.
   * Set to the workspace.markdown-viewport-menu event.
   */
  public name: ObsidianEventName = ObsidianEvent.workspace.viewportMenu;

  /**
   * Handles the viewport menu event by adding the "Show changes" toggle (checked
   * when every tracked change type is shown) to the native "view" section, so it
   * lines up with Obsidian's own gutter view toggles.
   *
   * @param {Menu} menu - The menu to add items to
   * @param {MarkdownView} _view - The markdown view (not used in this handler)
   * @param {string} _mode - The view mode ("source" or "preview"); not used here
   * @param {string} _source - Where the menu was opened from (e.g. "gutter")
   */
  public handler(menu: Menu, _view: MarkdownView, _mode: string, _source: string): void {
    const shown: boolean = this.settingsService.isShowChangesEnabled();

    menu.addItem((item: MenuItem): void => {
      item
        .setSection('view')
        .setTitle(this.plugin.t('menu.show-changes'))
        .setIcon('eye')
        .setChecked(shown)
        .onClick((): void => {
          this.settingsService.toggleShowChanges(!shown);
        });
    });
  };
}
