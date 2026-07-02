import type { TFile } from 'obsidian';

/**
 * Host port the {@link HistorySerializer} reads its plugin-facing dependencies
 * through. The serializer owns the serialize/restore/reconcile/orphan rules and
 * works directly against the {@link SnapshotRegistry} it is handed, but stays
 * free of the plugin: it resolves a persisted path to a live vault file, reads
 * the files currently open in the editor for the post-restore reconcile pass,
 * and schedules an external-capture re-check through the host, so
 * {@link SnapshotsService} keeps sole ownership of the plugin handle and the
 * sibling collaborators.
 */
export interface HistorySerializerHost {
  /**
   * Resolves a vault-relative path to its live {@link TFile}, or null when no
   * file exists at that path (deleted while the plugin was off, or an entry that
   * was already a tombstone on disk). Consulted from `onLayoutReady`, so a null
   * result is a real absence, not a transient indexing miss.
   *
   * @param {string} path - The vault-relative path to resolve
   * @return {TFile | null} The live file, or null when it is gone
   */
  getFileByPath(path: string): TFile | null;

  /**
   * The files currently open in the editor, re-checked after a restore pass so a
   * disk state that diverged while the plugin was off is caught (A1). Empty when
   * the plugin does not expose the workspace file set (test stubs or very early
   * init paths), which turns the reconcile pass into a no-op.
   *
   * @return {Set<TFile>} The open files, or an empty set
   */
  getOpenFiles(): Set<TFile>;

  /**
   * Schedules a debounced external-capture re-check for a file open after a
   * restore. The debounce coalesces an immediately following vault.modify event
   * into the same trailing disk read, preventing a double-capture.
   *
   * @param {TFile} file - The open file to re-check against disk
   */
  scheduleExternalCapture(file: TFile): void;
}
