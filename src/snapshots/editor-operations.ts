import type { EditorOperationsHost } from '@/snapshots/editor-operations.types';
import type { FileSnapshot } from '@/snapshots/file.snapshot';
import type { EditorBlock } from '@/types';
import type { TFile } from 'obsidian';

/**
 * Plain collaborator that owns the out-of-editor file-write concern of
 * {@link SnapshotsService}: applying a reverted block to a file while keeping
 * its snapshot in sync. It rewrites the changed block in the tracker (so
 * highlights stay correct even for a file that is not the active editor), sets
 * the cached state to the written content, refreshes the derived changes, then
 * writes the new content to disk and refreshes the editor.
 *
 * It is instantiated and owned by the service (not a DI service), so the DI
 * container's `constructor.name` resolution and registration ordering are
 * untouched. It reads the snapshot map through a narrow
 * {@link EditorOperationsHost} port and routes the post-write forced update back
 * through it, keeping the service the sole owner of snapshot CRUD.
 */
export class EditorOperations {
  /**
   * Creates a new EditorOperations bound to its owning service's host port.
   *
   * @param {EditorOperationsHost} host - The narrow port onto the snapshot state
   */
  public constructor(
    protected host: EditorOperationsHost,
  ) {
  }

  /**
   * Applies an out-of-editor content change to a file and keeps its snapshot in
   * sync, preserving the original baseline and the version timeline. Used by the
   * history modal to revert a single hunk: the block is rewritten in the tracker
   * (so highlights stay correct even for a file that is not the active editor),
   * the cached state is set to the written content, and the file is modified on
   * disk.
   *
   * The snapshot is updated before the file write so that, when the file is the
   * active editor, the change detector sees a matching content hash and skips
   * reprocessing the resulting editor update (no double application).
   *
   * @param {TFile | null} file - The file to rewrite
   * @param {string[]} lines - The full new content of the file as lines
   * @param {EditorBlock} block - The single block that changed, in tracker terms
   * @return {Promise<boolean>} True if the change was applied, false otherwise
   */
  public async applyContent(
    file: TFile | null,
    lines: string[],
    block: EditorBlock,
  ): Promise<boolean> {
    const snapshot: FileSnapshot | null = this.host.getSnapshot(file);

    if (!file || !snapshot || !Array.isArray(lines)) {
      return false;
    }

    snapshot.trackers.replaceBlock(block.start, block.removeCount, block.newLines);
    snapshot.content.updateState(lines);
    snapshot.updateChanges();

    await this.host.plugin.app.vault.modify(file, lines.join(snapshot.content.lineBreak));

    if (this.host.plugin.getActiveViewOfType()) {
      this.host.plugin.forceUpdateEditor();
    }

    this.host.forceUpdate();

    return true;
  }
}
