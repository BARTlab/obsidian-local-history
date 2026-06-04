import { FolderDeltaStatus, PluginEvent } from '@/consts';
import { Inject } from '@/decorators/inject.decorator';
import { On } from '@/decorators/on.decorator';
import { SessionStatusHelper } from '@/helpers/session-status.helper';
import type LineChangeTrackerPlugin from '@/main';
import type { SnapshotsService } from '@/services/snapshots.service';
import type { NativeFileExplorerItem, NativeFileExplorerView, Service } from '@/types';
import type { View, WorkspaceLeaf } from 'obsidian';

/**
 * Service that tints native Obsidian file-explorer rows by their session change
 * status (epic 11, M1). It owns no DOM of its own: it adds and removes the shared
 * `lct-tree-added` / `lct-tree-modified` classes on rows Obsidian renders
 * (`fileItems[path].selfEl`), so the file tree shows at a glance what was edited
 * or created this session, agreeing with the editor gutter by construction (D1).
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
   * The pending debounce timer for a scheduled sweep, or undefined when none is
   * in flight. Cleared on unload so no sweep fires after teardown.
   */
  protected timer: ReturnType<typeof setTimeout> | undefined = undefined;

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
   * Applies the initial decoration once the plugin is fully loaded, so files
   * already changed at load time are tinted without waiting for the next event.
   */
  public load(): void {
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
   * Removes every class this decorator added from the native rows and clears its
   * bookkeeping, so unloading the plugin leaves Obsidian's DOM exactly as found
   * (the classes are not auto-cleaned, unlike `registerEvent` refs). Mirrors the
   * `StylesService.unload` teardown contract.
   */
  public unload(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    const view: NativeFileExplorerView | null = this.getExplorerView();

    if (view?.fileItems) {
      for (const item of Object.values(view.fileItems)) {
        item?.selfEl?.classList.remove(...TreeTabDecoratorService.statusClasses);
      }
    }

    this.applied.clear();
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
   * Reconciles the native file rows with the current session statuses. Builds
   * the desired status for every live snapshot, then for every previously- or
   * newly-decorated path flips the row's class only when its status changed
   * since the last sweep. Paths that returned to `none` have their class removed
   * and drop out of the bookkeeping map. Guarded on `isReady()` and degrades
   * silently when the explorer or a row is missing (D8).
   */
  protected apply(): void {
    if (!this.plugin.isReady()) {
      return;
    }

    const view: NativeFileExplorerView | null = this.getExplorerView();

    if (!view?.fileItems) {
      return;
    }

    const desired: Map<string, FolderDeltaStatus> = this.computeStatuses();
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
      const path: string | undefined = snapshot.file?.path;

      if (!path) {
        continue;
      }

      const status: FolderDeltaStatus = SessionStatusHelper.statusOf(snapshot);

      if (status !== FolderDeltaStatus.none) {
        statuses.set(path, status);
      }
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
   * Resolves the native file-explorer view through the local augmentation, or
   * null when no explorer leaf is open. Untyped internal access (D8) is confined
   * to this one cast so the rest of the service stays typed.
   *
   * @return {NativeFileExplorerView | null} The explorer view, or null when absent
   */
  protected getExplorerView(): NativeFileExplorerView | null {
    const type: string = TreeTabDecoratorService.fileExplorerType;
    const leaf: WorkspaceLeaf | undefined = this.plugin.app.workspace.getLeavesOfType(type)[0];
    const view: View | undefined = leaf?.view;

    return view ? (view as unknown as NativeFileExplorerView) : null;
  }
}
