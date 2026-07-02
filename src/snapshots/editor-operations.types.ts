import type LineChangeTrackerPlugin from '@/main';
import type { FileSnapshot } from '@/snapshots/file.snapshot';
import type { TFile } from 'obsidian';

/**
 * Host port the {@link EditorOperations} collaborator reads its shared state
 * through. The collaborator owns the file-write flow (snapshot resync + disk
 * write + editor refresh) but stays stateless about the snapshot map: it asks
 * the host for the target file's snapshot and routes the editor refresh and the
 * post-write forced update back through the host so the {@link SnapshotsService}
 * keeps sole ownership of the snapshot CRUD.
 */
export interface EditorOperationsHost {
  /** The plugin instance, used for the disk write and the active-view check. */
  readonly plugin: LineChangeTrackerPlugin;

  /**
   * The snapshot for the given file, or `null` when the file is untracked.
   * Delegated to the host so the snapshot lookup stays owned by the service.
   *
   * @param {TFile | null} file - The file to look up, or null for the active file
   * @return {FileSnapshot | null} The snapshot, or null when none exists
   */
  getSnapshot(file?: TFile | null): FileSnapshot | null;

  /**
   * Notifies the observable snapshot map that a write mutated a snapshot so
   * subscribers (the editor, the tree/tab decorator) refresh.
   */
  forceUpdate(): void;
}
