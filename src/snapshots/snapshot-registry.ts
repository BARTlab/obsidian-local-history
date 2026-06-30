import { MapChangeAction } from '@/consts';
import * as PathHelper from '@/helpers/path.helper';
import { ObservableMap } from '@/maps/observable.map';
import { FileSnapshot } from '@/snapshots/file.snapshot';
import { FileVersion } from '@/snapshots/file.version';
import type { ChangeHandler } from '@/types';
import type { TFile } from 'obsidian';

/**
 * Host port the {@link SnapshotRegistry} reads its two outside dependencies
 * through. The registry owns the path-keyed snapshot map and the session-created
 * path set, but stays free of the plugin and its sibling collaborators: it asks
 * the host for the active editor's line break when creating a snapshot and
 * routes the "forget this path" signal to the external-capture collaborator when
 * a path is removed or renamed, so {@link SnapshotsService} keeps sole ownership
 * of the plugin handle and the collaborator wiring.
 */
export interface SnapshotRegistryHost {
  /**
   * The line ending of the active editor view, when one is open. Preferred over
   * sniffing the raw content so a freshly captured snapshot matches the editor
   * the user is looking at; undefined when no editor view is active, in which
   * case the registry falls back to detecting the ending from the content.
   *
   * @return {string | undefined} The active editor line break, or undefined
   */
  getActiveEditorLineBreak(): string | undefined;

  /**
   * Drops the external-capture debounce/in-flight/last-seen state for a path
   * that was just removed or renamed, so stale state for a now-absent or
   * relocated path cannot leak into a future modify event. Routed through the
   * host so the registry stays decoupled from the external-capture collaborator.
   *
   * @param {string} path - The vault-relative path to forget
   */
  forgetExternalCapture(path: string): void;
}

/**
 * Plain collaborator that owns the path-keyed registry concern of
 * {@link SnapshotsService}: the observable map of vault-relative paths to their
 * {@link FileSnapshot}, the transient set of paths the user created this session,
 * and the add/remove/rename/move/tombstone/rekey rules that keep those two in
 * step as files come, go, and move around the vault.
 *
 * It is instantiated and owned by the service (not a DI service), so the DI
 * container's `constructor.name` resolution and registration ordering are
 * untouched. It creates snapshots and forgets relocated paths through a narrow
 * {@link SnapshotRegistryHost} port, keeping the service the sole owner of the
 * plugin handle and the sibling collaborators.
 */
export class SnapshotRegistry {
  /**
   * Map of file paths to their corresponding snapshots. Uses ObservableMap to
   * notify subscribers when snapshots change.
   */
  protected snapshots: ObservableMap<string, FileSnapshot> = new ObservableMap<string, FileSnapshot>();

  /**
   * Vault paths of files CREATED by the user in the current app session.
   * Recorded by the `vault.create` handler regardless of the "ignore new
   * files" setting, so the tree/tab decorator can paint a freshly
   * created file as "added" even when that setting suppresses its snapshot (an
   * ignored new file has no snapshot to carry `createdThisSession`). Transient:
   * never persisted, so it resets to empty on restart and a created file stops
   * reading as new once the session that made it ends. Kept in step with the
   * snapshot map on remove/rename/move/clear so a stale path never tints a row
   * that has since changed identity.
   */
  protected sessionCreatedPaths: Set<string> = new Set();

  /**
   * Creates a new SnapshotRegistry bound to its owning service's host port.
   *
   * @param {SnapshotRegistryHost} host - The narrow port onto the two outside deps
   */
  public constructor(
    protected host: SnapshotRegistryHost,
  ) {
  }

  /**
   * Subscribes a handler to snapshot-map changes. The service uses this seam in
   * `init` to re-emit a plugin event so the tree/tab decorator refreshes when
   * snapshots change.
   *
   * @param {ChangeHandler<string, FileSnapshot>} handler - The change handler
   */
  public subscribe(handler: ChangeHandler<string, FileSnapshot>): void {
    this.snapshots.subscribe(handler);
  }

  /**
   * Gets the snapshot currently keyed by `path`, or undefined when the path has
   * no snapshot.
   *
   * @param {string} path - The vault-relative path to look up
   * @return {FileSnapshot | undefined} The snapshot, or undefined
   */
  public get(path: string): FileSnapshot | undefined {
    return this.snapshots.get(path);
  }

  /**
   * Checks whether a snapshot exists for `path`.
   *
   * @param {string} path - The vault-relative path to check
   * @return {boolean} True when a snapshot is keyed by the path
   */
  public has(path: string): boolean {
    return this.snapshots.has(path);
  }

  /**
   * Gets a copy of all snapshots currently in the registry.
   *
   * @return {FileSnapshot[]} An array of all file snapshots
   */
  public getAll(): FileSnapshot[] {
    return [...this.snapshots.values()];
  }

  /**
   * Iterates the `[path, snapshot]` pairs in the registry. The path is the map
   * key, which wins over `snapshot.file?.path` so a detached tombstone (file =
   * null) still surfaces under its last-known path.
   *
   * @return {IterableIterator<[string, FileSnapshot]>} The path/snapshot pairs
   */
  public entries(): IterableIterator<[string, FileSnapshot]> {
    return this.snapshots.entries();
  }

  /**
   * The set of vault paths created by the user this session. Read by the
   * tree/tab decorator to tint created files as "added" independently of whether
   * a snapshot exists for them.
   *
   * @return {ReadonlySet<string>} The session-created paths
   */
  public getSessionCreatedPaths(): ReadonlySet<string> {
    return this.sessionCreatedPaths;
  }

  /**
   * Notifies the observable snapshot map that a snapshot mutated so subscribers
   * (the editor, the tree/tab decorator) refresh.
   */
  public forceUpdate(): void {
    this.snapshots.next(MapChangeAction.update);
  }

  /**
   * Adds a new snapshot for the specified file. Creates a FileSnapshot with the
   * provided content and stores it under the file's path. The line break comes
   * from the active editor view when one is open (so the snapshot matches the
   * editor), falling back to detecting it from the content.
   *
   * @param {TFile} file - The file to create a snapshot for
   * @param {string} content - The content to snapshot
   */
  public add(file: TFile, content: string): void {
    if (!file) {
      return;
    }

    const activeLineBreak: string | undefined = this.host.getActiveEditorLineBreak();
    const lineBreak: string = activeLineBreak ?? (content.includes('\r\n') ? '\r\n' : '\n');

    this.snapshots.set(
      file.path,
      new FileSnapshot(content, lineBreak, file),
    );
  }

  /**
   * Inserts a fully constructed snapshot under `path`, bypassing the content
   * line-break detection of {@link add}. Used by the restore path, which
   * reconstructs a snapshot from its serialized form (history, tracker, and
   * version timeline already populated) rather than from raw content.
   *
   * @param {string} path - The vault-relative path to key the snapshot under
   * @param {FileSnapshot} snapshot - The pre-built snapshot to store
   */
  public set(path: string, snapshot: FileSnapshot): void {
    this.snapshots.set(path, snapshot);
  }

  /**
   * Removes the snapshot for the specified file: drops it from the map, clears
   * any session-created mark for its path, and forgets its external-capture
   * state so a stale timer cannot fire against the now-absent path.
   *
   * @param {TFile} file - The file whose snapshot should be removed
   */
  public remove(file: TFile): void {
    if (!file) {
      return;
    }

    this.deleteByPath(file.path);
    this.host.forgetExternalCapture(file.path);
  }

  /**
   * Drops the snapshot and any session-created mark keyed by `path`. The shared
   * delete primitive behind {@link remove} (which also forgets external-capture
   * state) and the exclude purge (which forgets external-capture state itself).
   *
   * @param {string} path - The vault-relative path to delete
   */
  public deleteByPath(path: string): void {
    this.snapshots.delete(path);
    this.sessionCreatedPaths.delete(path);
  }

  /**
   * Records that `path` was created by the user this session so the tree/tab
   * decorator can paint it as "added" even when the "ignore new files" setting
   * suppressed its snapshot. Called by the `vault.create` handler. Transient and
   * never persisted (see {@link sessionCreatedPaths}).
   *
   * @param {string} path - The vault-relative path of the created file
   */
  public markCreatedThisSession(path: string): void {
    if (path) {
      this.sessionCreatedPaths.add(path);
    }
  }

  /**
   * Marks the snapshot for the given file as a tombstone instead of
   * dropping it. The entry stays in the map under its current path so any
   * folder view at that prefix can still surface it, and its `state`,
   * `historyLines`, and `versions` are preserved so the file can be
   * reconstructed from history. The session-only marker baseline (`lines`)
   * and the live `tracker` are reset to empty arrays because they only
   * carry meaning against a live editor view, and the file is gone.
   *
   * No-op when the file is missing or when no snapshot exists at the path
   * (there is nothing to remember). Calling on an already-tombstoned entry
   * is also a no-op: the existing `deletedTimestamp` is preserved so a
   * later replay of the same delete signal cannot rewrite the original
   * tombstone moment.
   *
   * @param {TFile} file - The file that was deleted in the vault
   */
  public markDeleted(file: TFile): void {
    if (!file) {
      return;
    }

    const snapshot: FileSnapshot | undefined = this.snapshots.get(file.path);

    if (!snapshot || snapshot.isTombstone()) {
      return;
    }

    snapshot.deletedTimestamp = Date.now();
    snapshot.content.lines = [];
    snapshot.trackers.reset();
    snapshot.content.changes.clear();

    this.forceUpdate();
  }

  /**
   * Re-keys a snapshot after its file was renamed or moved.
   * Moves the snapshot from the old path to the file's current path and updates
   * the stored file reference, preserving the tracked history across the rename.
   *
   * @param {string} oldPath - The path the snapshot was previously keyed by
   * @param {TFile} file - The file in its renamed state (holding the new path)
   */
  public rename(oldPath: string, file: TFile): void {
    if (!oldPath || !file || oldPath === file.path) {
      return;
    }

    const snapshot: FileSnapshot | undefined = this.snapshots.get(oldPath);

    if (!snapshot) {
      return;
    }

    snapshot.file = file;
    snapshot.path = file.path;

    this.snapshots.delete(oldPath);
    this.snapshots.set(file.path, snapshot);
    this.rekeySessionCreated(oldPath, file.path);
    this.host.forgetExternalCapture(oldPath);
  }

  /**
   * Handles a cross-directory move: leaves a tombstone at `oldPath` and
   * re-keys the live snapshot to the file's new path while stamping
   * `movedIntoAt` with the call timestamp. The live snapshot's history baseline,
   * version timeline, and current state travel with it so the file's captured
   * history is continuous through the move; the tombstone left behind carries
   * a full copy of those same fields so a folder view at the source prefix can
   * still surface the file as deleted with its history intact.
   *
   * This method is the move-only entry point: it asserts that `oldPath` and the
   * file's new path belong to different directories (an in-place rename
   * stays a pure re-key through `rename`). Calling it without a directory
   * change throws so a wiring bug surfaces immediately rather than littering a
   * folder with phantom tombstones.
   *
   * No-op when `oldPath`, `file`, or the existing snapshot is missing: there is
   * nothing to remember, and the move signal can be safely ignored.
   *
   * @param {string} oldPath - The path the snapshot was previously keyed by
   * @param {TFile} file - The file in its moved state (holding the new path)
   */
  public markMoved(oldPath: string, file: TFile): void {
    if (!oldPath || !file || oldPath === file.path) {
      return;
    }

    if (PathHelper.dirname(oldPath) === PathHelper.dirname(file.path)) {
      throw new Error(
        `SnapshotRegistry.markMoved called without a directory change: ${oldPath} -> ${file.path}`,
      );
    }

    const snapshot: FileSnapshot | undefined = this.snapshots.get(oldPath);

    if (!snapshot) {
      return;
    }

    const now: number = Date.now();

    /**
     * Build the tombstone first so its preserved fields capture the live state
     * as it was before the move stamped movedIntoAt onto the migrating snapshot.
     * Session-only marker baseline and tracker are dropped on the tombstone for
     * the same reason markDeleted drops them: they carry meaning only against a
     * live editor view, and the file is no longer there.
     */
    const tombstone: FileSnapshot = new FileSnapshot('', snapshot.content.lineBreak);

    tombstone.file = null;
    tombstone.path = oldPath;
    tombstone.content.lines = [];
    tombstone.trackers.reset();
    tombstone.content.changes.clear();
    tombstone.content.historyLines = snapshot.content.getHistoryOriginalStateLines();
    tombstone.content.updateState(snapshot.content.getLastStateLines());
    tombstone.timeline.adopt(
      snapshot.timeline.getStoredVersions().map(
        (version: FileVersion): FileVersion => FileVersion.fromJSON(version.toJSON()),
      ),
    );
    tombstone.timestamp = snapshot.timestamp;
    tombstone.deletedTimestamp = now;

    /**
     * Re-key the live snapshot to the destination path and stamp the move
     * marker so the folder UI can colour it as added in the new directory even
     * though its captured history is older.
     */
    snapshot.file = file;
    snapshot.path = file.path;
    snapshot.movedIntoAt = now;

    this.snapshots.delete(oldPath);
    this.snapshots.set(file.path, snapshot);
    this.snapshots.set(oldPath, tombstone);
    this.rekeySessionCreated(oldPath, file.path);
  }

  /**
   * Moves a session-created mark from `oldPath` to `newPath` when the file is
   * renamed or moved, so a file created this session keeps reading as "added"
   * at its new path and the stale old path drops out. A no-op when the file was
   * not created this session.
   *
   * @param {string} oldPath - The path the file used to live at
   * @param {string} newPath - The path the file now lives at
   */
  protected rekeySessionCreated(oldPath: string, newPath: string): void {
    if (this.sessionCreatedPaths.delete(oldPath)) {
      this.sessionCreatedPaths.add(newPath);
    }
  }

  /**
   * Clears every snapshot and every session-created mark from the registry.
   * External-capture state is reset by the owning service, which composes both
   * collaborators.
   */
  public clear(): void {
    this.snapshots.clear();
    this.sessionCreatedPaths.clear();
  }
}
