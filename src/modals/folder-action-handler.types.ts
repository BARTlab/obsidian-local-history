import type LineChangeTrackerPlugin from '@/main';
import type { ModalsService } from '@/services/modals.service';
import type { SnapshotsService } from '@/services/snapshots.service';
import type { VersionActionsService } from '@/services/version-actions.service';
import type { FileSnapshot } from '@/snapshots/file.snapshot';
import type { FileVersion } from '@/snapshots/file.version';
import type { FolderDeltaResult } from '@/types';
import type { App } from 'obsidian';

/**
 * The tree-selected file resolved back to its snapshot and the per-file delta at
 * the picked timeline point T. Every action early-exits on a `null` selection.
 */
export interface FolderActionSelection {
  /** The vault-relative path of the selected file. */
  readonly path: string;

  /** The snapshot owning the selected file's history. */
  readonly snapshot: FileSnapshot;

  /** The per-file delta at the picked T (base / current content + status). */
  readonly result: FolderDeltaResult;
}

/**
 * Host port the {@link FolderActionHandler} reads its shared modal state through.
 * The handler owns the five toolbar actions plus the tombstone restore but stays
 * stateless about the modal: it reads the current selection and the version
 * closest to T back through this port, mutates the snapshot map via
 * {@link removeFromMap}, and signals a structural change via {@link resyncTimeline}
 * / {@link refreshTree} / {@link refreshDiff} so the modal re-renders the rail,
 * the tree, and the diff. Mirrors the host-port pattern the timeline and
 * diff renderers use: the handler never sees the modal's protected fields
 * directly.
 */
export interface FolderActionHost {
  /**
   * The Obsidian app, used to create / modify files on the tombstone-restore and
   * restore-original paths.
   */
  readonly app: App;

  /** The plugin instance, used for translation lookups. */
  readonly plugin: LineChangeTrackerPlugin;

  /** Confirms destructive actions and prompts for version labels. */
  readonly modalsService: ModalsService;

  /** Shared restore / remove action service, the same one the file modal uses. */
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

  /** Re-runs the per-file deltas and re-renders the tree against the current T. */
  refreshTree(): void;

  /** Re-renders the diff for the selected file at the current T. */
  refreshDiff(): void;
}
