import { FolderDeltaStatus } from '@/consts';
import type { FolderActionHost, FolderActionSelection } from '@/modals/folder-action-handler.types';
import type { FileSnapshot } from '@/snapshots/file.snapshot';
import type { FileVersion } from '@/snapshots/file.version';
import type { FolderDeltaResult } from '@/types';
import { Notice, type TFile } from 'obsidian';

/**
 * Toolbar-action collaborator for the folder-history modal.
 *
 * Extracted from {@link FolderHistoryModal} as a plain object the modal
 * instantiates and owns (per ADR-11: deep collaborators, not DI
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
   * closest to T is restored on the tree-selected file. When T
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
      const currentLines: string[] = selection.snapshot.content.getLastStateLines();
      const lineBreak: string = selection.snapshot.content.lineBreak;

      if (baseLines.join(lineBreak) !== currentLines.join(lineBreak)) {
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
   * Handler for the "Remove selected version" toolbar button. Drops the version
   * closest to T from the tree-selected file's timeline, then
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
     * Tombstones have a null `file` reference (they are left detached), so the
     * service's getOne lookup would miss. Drop the version directly off the
     * snapshot in that case and notify subscribers ourselves so retention and
     * the rail still see a consistent map.
     */
    if (file) {
      this.host.versionActionsService.removeSelected(file, version.id);
    } else if (selection.snapshot.timeline.removeVersion(version.id)) {
      this.host.snapshotsService.forceUpdate();
    }

    this.host.resyncTimeline();
    this.host.refreshTree();
    this.host.refreshDiff();
  }

  /**
   * Handler for the "Label selected version" toolbar button. Routes the version
   * closest to T through {@link ModalsService.labelVersion} so the label prompt
   * and the cancel/blank no-op contract match the file modal exactly.
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
      const originalContent: string = selection.snapshot.content.getHistoryOriginalState();

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
    const content: string = result.base.join(snapshot.content.lineBreak);

    // A deleted file's old path may now be occupied by a different file
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
      snapshot.content.updateState(result.base);
      snapshot.updateChanges();
      this.host.snapshotsService.forceUpdate();
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (_error) {
      new Notice(this.host.plugin.t('notice.file-restore-failed'));
    }
  }
}
