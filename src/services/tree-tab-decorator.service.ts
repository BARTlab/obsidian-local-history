import { FolderDeltaStatus, PluginEvent } from '@/consts';
import { Inject } from '@/decorators/inject.decorator';
import { On } from '@/decorators/on.decorator';
import { SessionStatusHelper } from '@/helpers/session-status.helper';
import type LineChangeTrackerPlugin from '@/main';
import type { SettingsService } from '@/services/settings.service';
import type { SnapshotsService } from '@/services/snapshots.service';
import type { NativeFileExplorerItem, NativeFileExplorerView, NativeWorkspaceLeaf, Service } from '@/types';
import { type MarkdownView, type View, type WorkspaceLeaf } from 'obsidian';

/**
 * Service that tints native Obsidian file-explorer rows and workspace tab headers
 * by their session change status (epic 11, M1 + M2). It owns no DOM of its own:
 * it adds and removes the shared `lct-tree-added` / `lct-tree-modified` classes on
 * rows Obsidian renders (`fileItems[path].selfEl`) and on the tab headers of open
 * files (`leaf.tabHeaderEl`), so the file tree and the tab bar show at a glance
 * what was edited or created this session, agreeing with the editor gutter by
 * construction (D1).
 *
 * Design constraints baked in here:
 *
 * - It never re-renders the explorer; it only flips classes on existing nodes
 *   (D2), so it is theme-safe and survives core updates.
 * - The native explorer is an untyped Obsidian internal; it is reached through
 *   the local {@link NativeFileExplorerView} augmentation with defensive optional
 *   access, and every entry point is gated on `plugin.isReady()` so a stale call
 *   degrades silently instead of throwing (D8).
 * - `SessionStatusHelper` yields only `added | modified | none`, so a tombstone
 *   resolves to `none` and is never painted (D5).
 * - Applies are debounced and diff-based: a burst of `snapshotsUpdate` events
 *   (one per keystroke) collapses into a single trailing sweep, and only rows
 *   whose status actually changed since the last apply are touched (D7).
 * - The classes it adds are not auto-cleaned by Obsidian, so `unload()` removes
 *   every one of them, mirroring the `StylesService` teardown pattern.
 * - The whole decorator is gated behind the `treeHighlight` setting (D9): when it
 *   is off, `apply()` clears every applied class and paints nothing further;
 *   flipping it back on re-applies the current statuses live without a reload,
 *   driven by the `settingsUpdate` fan-out.
 *
 * @implements {Service}
 */
export class TreeTabDecoratorService implements Service {
  /**
   * Service for reading the current set of file snapshots, the source the
   * session status is derived from.
   */
  @Inject('SnapshotsService')
  protected snapshotsService: SnapshotsService;

  /**
   * Service for reading the plugin settings, used to gate the whole decorator
   * behind the `treeHighlight` toggle (D9): off clears every applied class and
   * paints nothing further, on re-applies the current statuses live.
   */
  @Inject('SettingsService')
  protected settingsService: SettingsService;

  /**
   * Debounce window (ms) for a tree sweep. A burst of `snapshotsUpdate` events
   * within this window collapses into a single trailing apply, so per-keystroke
   * churn never triggers a per-keystroke full-tree sweep.
   */
  protected static readonly debounceMs: number = 100;

  /**
   * Obsidian view type id of the native file explorer leaf.
   */
  protected static readonly fileExplorerType: string = 'file-explorer';

  /**
   * Obsidian view type id of a markdown editor leaf, the only leaves whose tab
   * headers are decorated (a markdown leaf is the only one backed by a vault
   * `TFile` the session status can be resolved for).
   */
  protected static readonly markdownType: string = 'markdown';

  /**
   * The two status classes this decorator manages on native surfaces (D5: no
   * `lct-tree-deleted`). Removed wholesale from a row before the current status
   * class is re-applied so a status flip never leaves a stale colour behind.
   */
  protected static readonly statusClasses: readonly string[] = [
    TreeTabDecoratorService.classFor(FolderDeltaStatus.added),
    TreeTabDecoratorService.classFor(FolderDeltaStatus.modified),
  ];

  /**
   * Last status applied per vault path, so an apply only mutates rows whose
   * status changed since the previous sweep (the diff that keeps a sweep cheap).
   * A path drops out of the map when it returns to `none`.
   */
  protected applied: Map<string, FolderDeltaStatus> = new Map();

  /**
   * Last status applied per decorated tab header, keyed by the leaf itself (not
   * its path: two leaves can show the same file, and a leaf survives the file it
   * shows changing). Lets a tab sweep mutate only headers whose status changed
   * since the previous sweep, and gives `unload()` the exact set of leaves to
   * clear. A leaf drops out when its status returns to `none`.
   */
  protected appliedTabs: Map<NativeWorkspaceLeaf, FolderDeltaStatus> = new Map();

  /**
   * The pending debounce timer for a scheduled sweep, or undefined when none is
   * in flight. Cleared on unload so no sweep fires after teardown.
   */
  protected timer: ReturnType<typeof setTimeout> | undefined = undefined;

  /**
   * The `MutationObserver` watching the explorer container for lazily-rendered
   * rows (D7), or undefined when no container is currently observed. Expanding a
   * collapsed folder or a drag/drop mounts new `fileItems` rows WITHOUT firing a
   * plugin event, so `snapshotsUpdate` alone misses them; a childList mutation on
   * the container schedules a debounced re-apply that decorates the new rows. It
   * observes childList only, never attributes, so the decorator's own class flips
   * never re-trigger it. It is DOM we hold a handle to, not auto-cleaned, so it is
   * disconnected on unload.
   */
  protected observer: MutationObserver | undefined = undefined;

  /**
   * The explorer container the {@link observer} is currently attached to, kept so
   * the observer is only re-wired when the container element actually changes
   * (the explorer is recreated across some layout changes). Cleared on unload.
   */
  protected observed: HTMLElement | undefined = undefined;

  /**
   * Creates a new instance of TreeTabDecoratorService.
   *
   * @param {LineChangeTrackerPlugin} plugin - The plugin instance
   */
  public constructor(
    protected plugin: LineChangeTrackerPlugin,
  ) {
  }

  /**
   * Maps a status to the native-surface class name that paints it. The class
   * tokens (`lct-tree-added` / `lct-tree-modified`) are the same ones the modal
   * folder tree uses, sourced from the shared `--lct-status-*` palette (D3).
   *
   * @param {FolderDeltaStatus} status - The status to name a class for
   * @return {string} The `lct-tree-*` class name for that status
   */
  protected static classFor(status: FolderDeltaStatus): string {
    return `lct-tree-${status}`;
  }

  /**
   * Wires the refresh triggers and applies the initial decoration. Besides the
   * `snapshotsUpdate` fan-out ({@link refresh}), the tree and tabs must be
   * re-decorated on three more signals that carry no plugin event (D7): a
   * `layout-change` (the explorer or a tab bar can be recreated, dropping every
   * class this decorator added), an `active-leaf-change` (the active leaf
   * changed), and a `file-open` (a leaf swapped the file it shows, so its tab
   * needs a fresh status). All go through `plugin.registerEvent` so their refs
   * release on plugin unload, and each only `schedule()`s a debounced,
   * `isReady()`-guarded sweep that re-attaches the lazy-row observer and
   * re-applies the diff. The initial `schedule()` tints rows and tabs already
   * changed at load time without waiting for the next event.
   */
  public load(): void {
    this.plugin.registerEvent(
      this.plugin.app.workspace.on('layout-change', (): void => {
        this.schedule();
      }),
    );

    this.plugin.registerEvent(
      this.plugin.app.workspace.on('active-leaf-change', (): void => {
        this.schedule();
      }),
    );

    this.plugin.registerEvent(
      this.plugin.app.workspace.on('file-open', (): void => {
        this.schedule();
      }),
    );

    this.schedule();
  }

  /**
   * Re-decorates the tree on every snapshot change. Debounced so a burst of
   * edits collapses into a single trailing sweep (D7); the actual work runs in
   * {@link apply}.
   */
  @On(PluginEvent.snapshotsUpdate)
  public refresh(): void {
    this.schedule();
  }

  /**
   * Re-decorates on every settings change so the `treeHighlight` toggle reacts
   * live (D9): toggling it off makes the next scheduled {@link apply} clear every
   * applied class, and toggling it back on re-applies the current statuses
   * without a reload. Debounced like every other trigger; the toggle read itself
   * happens in {@link apply}, so this stays a uniform `schedule()`.
   */
  @On(PluginEvent.settingsUpdate)
  public onSettingsUpdate(): void {
    this.schedule();
  }

  /**
   * Removes every class this decorator added from the native rows and tab headers
   * and clears its bookkeeping, so unloading the plugin leaves Obsidian's DOM
   * exactly as found (the classes are not auto-cleaned, unlike `registerEvent`
   * refs). Mirrors the `StylesService.unload` teardown contract.
   */
  public unload(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    if (this.observer) {
      this.observer.disconnect();
      this.observer = undefined;
    }

    this.observed = undefined;

    this.clearAll();
  }

  /**
   * Schedules a debounced tree sweep. A pending timer is reset on each call so a
   * burst of triggers resolves to a single trailing {@link apply}.
   */
  protected schedule(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
    }

    this.timer = setTimeout((): void => {
      this.timer = undefined;
      this.apply();
    }, TreeTabDecoratorService.debounceMs);
  }

  /**
   * Reconciles the native file rows and the open-file tab headers with the
   * current session statuses. Builds the desired status for every live snapshot
   * once, then sweeps the explorer rows and the tab headers off the same map.
   * Both sweeps are diff-based (only surfaces whose status changed are touched)
   * and `isReady()`-guarded; each degrades silently when its surface is missing
   * (D8). The tab sweep runs even when no explorer is open, so tabs stay decorated
   * while the file tree is hidden. When the `treeHighlight` toggle is off (D9) the
   * sweep instead clears every applied class and paints nothing further, so the
   * feature can be switched off live.
   */
  protected apply(): void {
    if (!this.plugin.isReady()) {
      return;
    }

    if (!this.settingsService.value('treeHighlight')) {
      this.clearAll();

      return;
    }

    const desired: Map<string, FolderDeltaStatus> = this.computeStatuses();

    this.applyRows(desired);
    this.applyTabs(desired);
  }

  /**
   * Removes every class this decorator added from the native rows and tab headers
   * and empties the two bookkeeping maps, WITHOUT tearing down the refresh wiring
   * (timer, observer) the way {@link unload} does. Used when the `treeHighlight`
   * toggle flips off so the feature clears live yet stays able to re-decorate the
   * moment it is flipped back on. Idempotent: a second call clears nothing because
   * the maps are already empty.
   */
  protected clearAll(): void {
    const view: NativeFileExplorerView | null = this.getExplorerView();

    if (view?.fileItems) {
      for (const item of Object.values(view.fileItems)) {
        item?.selfEl?.classList.remove(...TreeTabDecoratorService.statusClasses);
      }
    }

    for (const leaf of this.appliedTabs.keys()) {
      leaf.tabHeaderEl?.classList.remove(...TreeTabDecoratorService.statusClasses);
    }

    this.applied.clear();
    this.appliedTabs.clear();
  }

  /**
   * Reconciles the native file-explorer rows with the desired statuses. For every
   * previously- or newly-decorated path it flips the row's class only when its
   * status changed since the last sweep; paths that returned to `none` have their
   * class removed and drop out of the bookkeeping map. A no-op (beyond clearing no
   * rows) when no explorer leaf is open. Re-attaches the lazy-row observer to the
   * live container on each sweep.
   *
   * @param {Map<string, FolderDeltaStatus>} desired - File/folder path to its session status
   */
  protected applyRows(desired: Map<string, FolderDeltaStatus>): void {
    const view: NativeFileExplorerView | null = this.getExplorerView();

    if (!view?.fileItems) {
      return;
    }

    this.syncObserver(this.getExplorerContainer());

    const paths: Set<string> = new Set([...this.applied.keys(), ...desired.keys()]);

    for (const path of paths) {
      const next: FolderDeltaStatus = desired.get(path) ?? FolderDeltaStatus.none;
      const prev: FolderDeltaStatus | undefined = this.applied.get(path);

      if (next === prev) {
        continue;
      }

      this.decorateRow(view.fileItems[path], next);

      if (next === FolderDeltaStatus.none) {
        this.applied.delete(path);
      } else {
        this.applied.set(path, next);
      }
    }
  }

  /**
   * Reconciles the open markdown tab headers with the desired statuses. Resolves
   * each markdown leaf's file, looks its status up in the file path map (folder
   * tints never apply to a tab), and flips the header class only when it changed
   * since the last sweep. A leaf no longer open, or whose status returned to
   * `none`, has its class removed and drops out of the tab bookkeeping. Degrades
   * silently when a leaf has no `tabHeaderEl` or no file (D8).
   *
   * @param {Map<string, FolderDeltaStatus>} desired - File/folder path to its session status
   */
  protected applyTabs(desired: Map<string, FolderDeltaStatus>): void {
    const open: Map<NativeWorkspaceLeaf, FolderDeltaStatus> = new Map();

    for (const leaf of this.getMarkdownLeaves()) {
      const path: string | undefined = (leaf.view as MarkdownView)?.file?.path;
      const status: FolderDeltaStatus = (path ? desired.get(path) : undefined) ?? FolderDeltaStatus.none;

      if (status !== FolderDeltaStatus.none) {
        open.set(leaf, status);
      }
    }

    const leaves: Set<NativeWorkspaceLeaf> = new Set([...this.appliedTabs.keys(), ...open.keys()]);

    for (const leaf of leaves) {
      const next: FolderDeltaStatus = open.get(leaf) ?? FolderDeltaStatus.none;
      const prev: FolderDeltaStatus | undefined = this.appliedTabs.get(leaf);

      if (next === prev) {
        continue;
      }

      this.decorateTab(leaf, next);

      if (next === FolderDeltaStatus.none) {
        this.appliedTabs.delete(leaf);
      } else {
        this.appliedTabs.set(leaf, next);
      }
    }
  }

  /**
   * Builds the per-path desired status for both file and folder rows. Each live
   * snapshot the helper resolves to a paintable status (`added` / `modified`)
   * contributes its file row; a `none` snapshot (including any tombstone, D5) is
   * omitted so its row carries no class. Every ancestor folder of a changed file
   * is then tinted the single `modified` token (D6), so a folder is painted iff
   * it still contains a session change and clears symmetrically once none remain.
   *
   * @return {Map<string, FolderDeltaStatus>} File/folder path to its session status
   */
  protected computeStatuses(): Map<string, FolderDeltaStatus> {
    const statuses: Map<string, FolderDeltaStatus> = new Map();

    for (const snapshot of this.snapshotsService.getList()) {
      /**
       * Resolve the path without depending on a live `TFile` (epic 12). After a
       * reload a restored snapshot has `file == null` until it is re-captured
       * this session, so `file?.path` alone drops it from the tint map and the
       * folder stops painting even though its `modified` status survives the
       * restart (epic 11 intent). The carried `path` mirrors the map key and is
       * the same fallback the folder-history readers use.
       */
      const path: string | undefined = snapshot.file?.path ?? snapshot.path;

      if (!path) {
        continue;
      }

      const status: FolderDeltaStatus = SessionStatusHelper.statusOf(snapshot);

      if (status !== FolderDeltaStatus.none) {
        statuses.set(path, status);
      }
    }

    /**
     * Files the user created this session read as `added` even when the
     * "ignore new files" setting suppressed their snapshot (epic 11): such a
     * file has no snapshot above, so its status comes from the session-created
     * path set instead. `added` overrides any `modified` already set for the
     * same path (created-this-session is the more informative read, D4).
     */
    for (const path of this.snapshotsService.getSessionCreatedPaths()) {
      statuses.set(path, FolderDeltaStatus.added);
    }

    const filePaths: string[] = [...statuses.keys()];

    for (const folder of SessionStatusHelper.ancestorFolderPaths(filePaths)) {
      statuses.set(folder, FolderDeltaStatus.modified);
    }

    return statuses;
  }

  /**
   * Sets a single row's status class: removes both managed classes, then adds
   * the one for `status` unless it is `none`. A no-op when the row is missing
   * (it is not currently rendered), which is the lazily-rendered-DOM case left
   * to the observer in a later task.
   *
   * @param {NativeFileExplorerItem | undefined} item - The row to decorate, if rendered
   * @param {FolderDeltaStatus} status - The status to paint, or `none` to clear
   */
  protected decorateRow(item: NativeFileExplorerItem | undefined, status: FolderDeltaStatus): void {
    const el: HTMLElement | undefined = item?.selfEl;

    if (!el) {
      return;
    }

    el.classList.remove(...TreeTabDecoratorService.statusClasses);

    if (status !== FolderDeltaStatus.none) {
      el.classList.add(TreeTabDecoratorService.classFor(status));
    }
  }

  /**
   * Sets a single tab header's status class: removes both managed classes, then
   * adds the one for `status` unless it is `none`. A no-op when the leaf exposes
   * no `tabHeaderEl` (an untyped internal that may be absent, D8).
   *
   * @param {NativeWorkspaceLeaf} leaf - The leaf whose tab header to decorate
   * @param {FolderDeltaStatus} status - The status to paint, or `none` to clear
   */
  protected decorateTab(leaf: NativeWorkspaceLeaf, status: FolderDeltaStatus): void {
    const el: HTMLElement | undefined = leaf.tabHeaderEl;

    if (!el) {
      return;
    }

    el.classList.remove(...TreeTabDecoratorService.statusClasses);

    if (status !== FolderDeltaStatus.none) {
      el.classList.add(TreeTabDecoratorService.classFor(status));
    }
  }

  /**
   * (Re)attaches the lazy-row {@link observer} to the live explorer container.
   * The observer is wired only when the container element actually changes (a
   * layout change can recreate the explorer), so steady-state sweeps do not churn
   * it; a recreated explorer disconnects the stale observer and re-observes the
   * new container. It watches `childList` with `subtree` so any expand/collapse,
   * drag, or filter that mounts new rows fires it, but never `attributes`, so the
   * decorator's own class flips inside {@link apply} never re-trigger it (no
   * feedback loop). The container is reached through the typed `View.containerEl`,
   * not an internal, and a missing container degrades to no observer (D8).
   *
   * @param {HTMLElement | undefined} container - The explorer container to observe
   */
  protected syncObserver(container: HTMLElement | undefined): void {
    if (!container) {
      return;
    }

    if (this.observed === container && this.observer) {
      return;
    }

    if (this.observer) {
      this.observer.disconnect();
    }

    this.observer = new MutationObserver((): void => {
      this.schedule();
    });

    this.observer.observe(container, { childList: true, subtree: true });
    this.observed = container;
  }

  /**
   * Resolves the native file-explorer view through the local augmentation, or
   * null when no explorer leaf is open. Untyped internal access (D8) is confined
   * to this one cast so the rest of the service stays typed.
   *
   * @return {NativeFileExplorerView | null} The explorer view, or null when absent
   */
  protected getExplorerView(): NativeFileExplorerView | null {
    const view: View | undefined = this.getExplorerLeaf()?.view;

    return view ? (view as unknown as NativeFileExplorerView) : null;
  }

  /**
   * Resolves the explorer container element the lazy-row observer watches,
   * through the typed `View.containerEl` (no internal access needed), or
   * undefined when no explorer leaf is open. Kept separate from
   * {@link getExplorerView} so the observer wiring stays on typed DOM.
   *
   * @return {HTMLElement | undefined} The explorer container, or undefined when absent
   */
  protected getExplorerContainer(): HTMLElement | undefined {
    return this.getExplorerLeaf()?.view.containerEl;
  }

  /**
   * Resolves the first open native file-explorer leaf, or undefined when none is
   * open. The single `getLeavesOfType` lookup both the typed and the augmented
   * accessors share.
   *
   * @return {WorkspaceLeaf | undefined} The explorer leaf, or undefined when absent
   */
  protected getExplorerLeaf(): WorkspaceLeaf | undefined {
    return this.plugin.app.workspace.getLeavesOfType(TreeTabDecoratorService.fileExplorerType)[0];
  }

  /**
   * Resolves every open markdown leaf, each viewed through the local
   * {@link NativeWorkspaceLeaf} augmentation so its untyped `tabHeaderEl` is in
   * reach (D8). Markdown leaves are the only ones backed by a vault `TFile` whose
   * session status the tab sweep can resolve.
   *
   * @return {NativeWorkspaceLeaf[]} The open markdown leaves
   */
  protected getMarkdownLeaves(): NativeWorkspaceLeaf[] {
    return this.plugin.app.workspace
      .getLeavesOfType(TreeTabDecoratorService.markdownType) as NativeWorkspaceLeaf[];
  }
}
