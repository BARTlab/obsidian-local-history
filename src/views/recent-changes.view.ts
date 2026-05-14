import { RECENT_CHANGES_VIEW_TYPE } from '@/consts';
import type LineChangeTrackerPlugin from '@/main';
import { type IconName, ItemView, type WorkspaceLeaf } from 'obsidian';

/**
 * Default user-facing title for the right-sidebar tab. Kept inline (matching
 * the T06 precedent) so T10 stays within its declared files; T15 replaces the
 * literal with a `plugin.t('view.recent-changes.title')` call along with the
 * matching `lang/` keys and the parity test pass.
 */
const RECENT_CHANGES_DEFAULT_TITLE: string = 'Recent changes';

/**
 * Right-sidebar navigator for the active file's version timeline (D3).
 *
 * T10 introduces the registration and lifecycle skeleton only: a stable view
 * type, the icon, the display text, and a single-leaf reveal contract. The
 * actual timeline rows, the active-leaf reaction, and the row context menu are
 * wired in T11 and T12, which fill `contentEl` with the navigator UI.
 *
 * The view is mutually exclusive with the modal's left rail (D4): launching
 * the history modal from this panel opens it in rail-less mode so a single
 * navigator drives the session.
 *
 * @extends {ItemView}
 */
export class RecentChangesView extends ItemView {
  /**
   * Creates a new instance of RecentChangesView.
   *
   * @param {WorkspaceLeaf} leaf - The workspace leaf hosting this view
   * @param {LineChangeTrackerPlugin} plugin - The plugin instance, retained so
   *   later tasks (T11/T12) can reach services through the DI container
   */
  public constructor(
    leaf: WorkspaceLeaf,
    protected plugin: LineChangeTrackerPlugin,
  ) {
    super(leaf);
  }

  /**
   * Returns the stable view type id used to register and look up the view.
   *
   * @return {string} The view type id
   * @override
   */
  public getViewType(): string {
    return RECENT_CHANGES_VIEW_TYPE;
  }

  /**
   * Returns the user-facing title rendered in the sidebar tab.
   *
   * @return {string} The localized display text
   * @override
   */
  public getDisplayText(): string {
    return RECENT_CHANGES_DEFAULT_TITLE;
  }

  /**
   * Returns the Lucide icon id rendered in the sidebar tab. Matches the
   * `history` icon used by the modal's toolbar so the surface is recognisable.
   *
   * @return {IconName} The Lucide icon id
   * @override
   */
  public getIcon(): IconName {
    return 'history';
  }

  /**
   * Resolves the view type id this view exposes. Convenience for the reveal
   * entry point (and tests) so callers do not have to import the constant.
   *
   * @return {string} The view type id
   */
  public static get viewType(): string {
    return RECENT_CHANGES_VIEW_TYPE;
  }

  /**
   * Lifecycle hook called when Obsidian opens the view.
   *
   * Prepares the content host with a stable class so T11's renderer can attach
   * timeline rows without re-applying the wrapper on every active-leaf change.
   * No listeners or intervals are registered here: T10 owns the skeleton only,
   * and any future subscription must use `registerEvent`/`registerDomEvent`
   * (inherited from Component) so detaching the leaf releases them.
   *
   * @return {Promise<void>} Resolves once the host is prepared
   * @override
   */
  protected async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass('lct-recent-changes-view');
  }

  /**
   * Lifecycle hook called when Obsidian closes the view.
   *
   * Empties the content host so a re-open starts from a clean DOM. Component
   * lifetime handles any registered event refs and dom listeners, so no
   * explicit detach is needed here.
   *
   * @return {Promise<void>} Resolves once the host is cleared
   * @override
   */
  protected async onClose(): Promise<void> {
    this.contentEl.empty();
  }
}
