import { FolderDeltaStatus } from '@/consts';
import type LineChangeTrackerPlugin from '@/main';
import type { ModalsService } from '@/services/modals.service';
import type { SnapshotsService } from '@/services/snapshots.service';
import type { VersionActionsService } from '@/services/version-actions.service';
import type { FileSnapshot } from '@/snapshots/file.snapshot';
import type { FileVersion } from '@/snapshots/file.version';
import type { FolderDeltaResult } from '@/types';
import { type App, Notice, type TFile } from 'obsidian';

/**
 * The tree-selected file resolved back to its snapshot and the per-file delta at
 * the picked timeline point T. Every action early-exits on a `null` selection.
 */
export interface FolderActionSelection {
  /**
   * The vault-relative path of the selected file.
   */
  readonly path: string;

  /**
   * The snapshot owning the selected file's history.
   */
  readonly snapshot: FileSnapshot;

  /**
   * The per-file delta at the picked T (base / current content + status).
   */
  readonly result: FolderDeltaResult;
}

/**
 * Host port the {@link FolderActionHandler} reads its shared modal state through.
 * The handler owns the five toolbar actions plus the tombstone restore but stays
 * stateless about the modal: it reads the current selection and the version
 * closest to T back through this port, mutates the snapshot map via
 * {@link removeFromMap}, and signals a structural change via {@link resyncTimeline}
 * / {@link refreshTree} / {@link refreshDiff} so the modal re-renders the rail,
 * the tree, and the diff. Mirrors the host-port pattern the timeline (T07) and
 * diff (T08) renderers use: the handler never sees the modal's protected fields
 * directly.
 */
export interface FolderActionHost {
  /**
   * The Obsidian app, used to create / modify files on the tombstone-restore and
   * restore-original paths.
   */
  readonly app: App;

  /**
   * The plugin instance, used for translation lookups.
   */
  readonly plugin: LineChangeTrackerPlugin;

  /**
   * Confirms destructive actions and prompts for version labels.
   */
  readonly modalsService: ModalsService;

  /**
   * Shared restore / remove action service, the same one the file modal uses.
   */
  readonly versionActionsService: VersionActionsService;

  /**
   * Snapshots service used to apply content, wipe a file's history, and force a
   * refresh after a direct snapshot mutation.
   */
  readonly snapshotsService: SnapshotsService;

  /**
   * Resolves the file currently focused in the tree back to its snapshot and the
   * per-file delta at T, or `null` when nothing actionable is selected.
   *
   * @return {FolderActionSelection | null} The resolved selection, or null
   */
  resolveSelection(): FolderActionSelection | null;

  /**
   * Resolves the captured version of the given snapshot closest to (but not
   * after) the picked T, or `null` when T precedes every captured version.
   *
   * @param {FileSnapshot} snapshot - The file's snapshot
   * @return {FileVersion | null} The closest version at/before T, or null
   */
  resolveVersionAtT(snapshot: FileSnapshot): FileVersion | null;

  /**
   * Removes the snapshot at the given path from the modal's snapshot map after a
   * destructive action that dropped the file's history.
   *
   * @param {string} path - The vault-relative path to drop
   */
  removeFromMap(path: string): void;

  /**
   * Re-synthesises the folder timeline from the live snapshot map and re-renders
   * the rail. Used after an action that removed a version or wiped a file.
   */
  resyncTimeline(): void;

  /**
   * Re-runs the per-file deltas and re-renders the tree against the current T.
   */
  refreshTree(): void;

  /**
   * Re-renders the diff for the selected file at the current T.
   */
  refreshDiff(): void;
}

/**
 * Toolbar-action collaborator for the folder-history modal (T09).
 *
 * Extracted from {@link FolderHistoryModal} as a plain object the modal
 * instantiates and owns (per ADR-8 / Epic 14: deep collaborators, not DI
 * services). It owns the five async toolbar actions (restore-selected,
 * remove-selected, label-selected, restore-original, remove-history) plus the
 * deleted-file tombstone restore path. It is stateless about the modal and reads
 * the current selection / closest version back through {@link FolderActionHost},
 * mutating the snapshot map and re-rendering the rail, tree, and diff through the
 * host callbacks, so confirmations, service calls, and outcomes stay identical to
 * the file modal's behaviour.
 */
export class FolderActionHandler {
  /**
   * @param {FolderActionHost} host - The modal port the handler reads its shared
   *   state through and drives the post-action re-render with.
   */
  public constructor(protected readonly host: FolderActionHost) {}

  /**
   * Handler for the "Restore selected version" toolbar button. The version
   * closest to T is restored on the tree-selected file (D10/AC1). When T
   * precedes every captured version, the synthetic baseline branch writes the
   * `compareAt` base back through {@link SnapshotsService.applyContent} so the
   * file's earliest known content is still restorable. When the selected file
   * is a tombstone with `deletedTimestamp > T` (AC4), the file is re-created at
   * its old path with the content at T and the tombstone is promoted back to a
   * live snapshot in place.
   *
   * @return {Promise<void>}
   */
  public async handleRestoreSelected(): Promise<void> {
    const selection: FolderActionSelection | null = this.host.resolveSelection();

    if (!selection) {
      return;
    }

    const confirmed: boolean = await this.host.modalsService.confirm({
      title: this.host.plugin.t('modal.confirm.restore-version.title'),
      message: this.host.plugin.t('modal.confirm.restore-version.message'),
      confirmText: this.host.plugin.t('modal.confirm.restore-version.button'),
      cancelText: this.host.plugin.t('modal.confirm.cancel'),
    });

    if (!confirmed) {
      return;
    }

    if (selection.snapshot.isTombstone() && selection.result.status === FolderDeltaStatus.deleted) {
      await this.restoreTombstoneSelection(selection.path, selection.snapshot, selection.result);
      this.host.resyncTimeline();
      this.host.refreshTree();
      this.host.refreshDiff();

      return;
    }

    const file: TFile | null = selection.snapshot.file ?? null;

    if (!file) {
      return;
    }

    const version: FileVersion | null = this.host.resolveVersionAtT(selection.snapshot);

    if (version) {
      await this.host.versionActionsService.restoreSelected(file, version.id);
    } else {
      /**
       * Synthetic baseline branch: T precedes every captured version, so the
       * base resolved by FolderDeltaHelper is the history baseline. Reuse the
       * same applyContent path the file modal's ORIGINAL_BASE_ID branch uses
       * so the tracker and the cached state stay in sync after the write.
       */
      const baseLines: string[] = selection.result.base;
      const currentLines: string[] = selection.snapshot.getLastStateLines();

      if (baseLines.join(selection.snapshot.lineBreak) !== currentLines.join(selection.snapshot.lineBreak)) {
        await this.host.snapshotsService.applyContent(file, baseLines, {
          start: 0,
          removeCount: currentLines.length,
          newLines: baseLines,
        });
      }
    }

    this.host.refreshTree();
    this.host.refreshDiff();
  }

  /**
   * Promotes a tombstone back to a live snapshot for AC4: writes the resolved
   * base content to disk at the snapshot's old path through
   * {@link App.vault.create}, attaches the resulting file to the snapshot, and
   * clears the tombstone marker so the entry becomes live in the map without
   * losing its captured versions or history baseline. A best-effort path: on a
   * vault error a Notice surfaces the failure and the tombstone stays as-is so
   * the user can retry.
   *
   * @param {string} path - The vault-relative old path of the deleted file
   * @param {FileSnapshot} snapshot - The tombstone snapshot to promote
   * @param {FolderDeltaResult} result - The compareAt result carrying the base content at T
   * @return {Promise<void>}
   */
  protected async restoreTombstoneSelection(
    path: string,
    snapshot: FileSnapshot,
    result: FolderDeltaResult,
  ): Promise<void> {
    const content: string = result.base.join(snapshot.lineBreak);

    // T14: a deleted file's old path may now be occupied by a different file
    // (recreated or renamed since deletion). `vault.create` throws on an
    // existing path and the generic catch below would hide the cause from the
    // user; pre-check here and surface a distinct notice so they can resolve
    // the collision manually instead of seeing a vague "restore failed".
    if (this.host.app.vault.getAbstractFileByPath(path) !== null) {
      new Notice(this.host.plugin.t('notice.file-restore-path-occupied'));

      return;
    }

    try {
      const created: TFile = await this.host.app.vault.create(path, content);

      snapshot.file = created;
      snapshot.deletedTimestamp = undefined;
      snapshot.updateState(result.base);
      snapshot.updateChanges();
      this.host.snapshotsService.forceUpdate();
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (_error) {
      new Notice(this.host.plugin.t('notice.file-restore-failed'));
    }
  }

  /**
   * Handler for the "Remove selected version" toolbar button. Drops the version
   * closest to T from the tree-selected file's timeline (D10/AC2), then
   * re-synthesises the folder timeline and re-renders the tree so the rail and
   * the per-file delta reflect the removed point. A no-op for a tombstone with
   * no captured version at T (there is nothing to remove without violating the
   * "version closest to T" semantics).
   *
   * @return {Promise<void>}
   */
  public async handleRemoveSelected(): Promise<void> {
    const selection: FolderActionSelection | null = this.host.resolveSelection();

    if (!selection) {
      return;
    }

    const version: FileVersion | null = this.host.resolveVersionAtT(selection.snapshot);

    if (!version) {
      return;
    }

    const confirmed: boolean = await this.host.modalsService.confirm({
      title: this.host.plugin.t('modal.confirm.remove-version.title'),
      message: this.host.plugin.t('modal.confirm.remove-version.message'),
      confirmText: this.host.plugin.t('modal.confirm.remove-version.button'),
      cancelText: this.host.plugin.t('modal.confirm.cancel'),
    });

    if (!confirmed) {
      return;
    }

    const file: TFile | null = selection.snapshot.file ?? null;

    /**
     * Tombstones have a null `file` reference (D2 leaves them detached), so the
     * service's getOne lookup would miss. Drop the version directly off the
     * snapshot in that case and notify subscribers ourselves so retention and
     * the rail still see a consistent map.
     */
    if (file) {
      this.host.versionActionsService.removeSelected(file, version.id);
    } else if (selection.snapshot.removeVersion(version.id)) {
      this.host.snapshotsService.forceUpdate();
    }

    this.host.resyncTimeline();
    this.host.refreshTree();
    this.host.refreshDiff();
  }

  /**
   * Handler for the "Label selected version" toolbar button. Routes the version
   * closest to T through {@link ModalsService.labelVersion} so the label prompt
   * and the cancel/blank no-op contract match the file modal exactly (D10/AC3).
   * A no-op for a tombstone whose snapshot has no live `file` reference (the
   * modals service resolves the label target by file).
   *
   * @return {Promise<void>}
   */
  public async handleLabelSelected(): Promise<void> {
    const selection: FolderActionSelection | null = this.host.resolveSelection();

    if (!selection) {
      return;
    }

    const version: FileVersion | null = this.host.resolveVersionAtT(selection.snapshot);
    const file: TFile | null = selection.snapshot.file ?? null;

    if (!version || !file) {
      return;
    }

    const labeled: FileVersion | null = await this.host.modalsService.labelVersion(file, version.id);

    if (!labeled) {
      return;
    }

    this.host.refreshTree();
    this.host.refreshDiff();
  }

  /**
   * Handler for the "Restore original" toolbar button. Asks for confirmation
   * and, on consent, rewrites the tree-selected file back to its history
   * baseline and drops its snapshot, mirroring the file modal's destructive
   * action. The folder modal stays open: the tree re-colours so the user can
   * see the rest of the subtree, the now-untracked file simply leaves the delta
   * view.
   *
   * @return {Promise<void>}
   */
  public async handleRestoreOriginal(): Promise<void> {
    const selection: FolderActionSelection | null = this.host.resolveSelection();

    if (!selection) {
      return;
    }

    const file: TFile | null = selection.snapshot.file ?? null;

    if (!file) {
      return;
    }

    const confirmed: boolean = await this.host.modalsService.confirm({
      title: this.host.plugin.t('modal.confirm.restore.title'),
      message: this.host.plugin.t('modal.confirm.restore.message'),
      confirmText: this.host.plugin.t('modal.confirm.restore.button'),
      cancelText: this.host.plugin.t('modal.confirm.cancel'),
    });

    if (!confirmed) {
      return;
    }

    try {
      const originalContent: string = selection.snapshot.getHistoryOriginalState();

      await this.host.app.vault.modify(file, originalContent);
      this.host.snapshotsService.wipeOne(file);
      this.host.removeFromMap(selection.path);

      new Notice(this.host.plugin.t('notice.file-restored'));
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (_error) {
      new Notice(this.host.plugin.t('notice.file-restore-failed'));

      return;
    }

    this.host.resyncTimeline();
    this.host.refreshTree();
    this.host.refreshDiff();
  }

  /**
   * Handler for the "Remove history" toolbar button. Asks for confirmation and,
   * on consent, drops the tree-selected file's snapshot through
   * {@link SnapshotsService.wipeOne}, leaving the file's content untouched on
   * disk. The folder modal stays open and the tree is re-coloured so the
   * remaining changed files stay visible.
   *
   * @return {Promise<void>}
   */
  public async handleRemoveHistory(): Promise<void> {
    const selection: FolderActionSelection | null = this.host.resolveSelection();

    if (!selection) {
      return;
    }

    const file: TFile | null = selection.snapshot.file ?? null;

    /**
     * Tombstone branch: no live file to write to. Remove-history on a deleted
     * file has no analogue in the file modal (where the modal closes after the
     * wipe), so the folder modal treats it as a no-op for tombstones and lets
     * tombstone retention age the entry out instead.
     */
    if (!file) {
      return;
    }

    const confirmed: boolean = await this.host.modalsService.confirm({
      title: this.host.plugin.t('modal.confirm.remove.title'),
      message: this.host.plugin.t('modal.confirm.remove.message'),
      confirmText: this.host.plugin.t('modal.confirm.remove.button'),
      cancelText: this.host.plugin.t('modal.confirm.cancel'),
    });

    if (!confirmed) {
      return;
    }

    this.host.snapshotsService.wipeOne(file);
    this.host.removeFromMap(selection.path);
    this.host.resyncTimeline();
    this.host.refreshTree();
    this.host.refreshDiff();
  }
}
