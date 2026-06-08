import { MapChangeAction, PluginEvent } from '@/consts';
import { Inject } from '@/decorators/inject.decorator';
import { PathHelper } from '@/helpers/path.helper';
import type LineChangeTrackerPlugin from '@/main';
import { ObservableMap } from '@/maps/observable.map';
import { ExternalChangeCapture, type ExternalChangeHost } from '@/services/external-change-capture';
import type { SettingsService } from '@/services/settings.service';
import { EditorOperations, type EditorBlock, type EditorOperationsHost } from '@/snapshots/editor-operations';
import { FileSnapshot } from '@/snapshots/file.snapshot';
import { FileVersion } from '@/snapshots/file.version';
import { IgnoreListManager, type IgnoreListHost } from '@/snapshots/ignore-list';
import type { SerializedFileSnapshot, SerializedHistory, Service, SnapshotCaptureOptions } from '@/types';
import { Notice, type TFile } from 'obsidian';

/**
 * Service responsible for managing file snapshots.
 * Tracks file content changes and provides methods to capture, retrieve, and manage snapshots.
 *
 * @implements {Service}
 */
export class SnapshotsService implements Service {
  /**
   * Service for accessing and updating plugin settings.
   * Injected using the @Inject decorator.
   */
  @Inject('SettingsService')
  protected settingsService: SettingsService;

  /**
   * Map of file paths to their corresponding snapshots.
   * Uses ObservableMap to notify subscribers when snapshots change.
   */
  protected fileSnapshots: ObservableMap<string, FileSnapshot> = new ObservableMap<string, FileSnapshot>();

  /**
   * Vault paths of files CREATED by the user in the current app session (epic
   * 11). Recorded by the `vault.create` handler regardless of the
   * "ignore new files" setting, so the tree/tab decorator can paint a freshly
   * created file as "added" even when that setting suppresses its snapshot (an
   * ignored new file has no snapshot to carry `createdThisSession`). Transient:
   * never persisted, so it resets to empty on restart and a created file stops
   * reading as new once the session that made it ends. Kept in step with the
   * snapshot map on remove/rename/move/clear so a stale path never tints a row
   * that has since changed identity.
   */
  protected sessionCreatedPaths: Set<string> = new Set<string>();

  /**
   * Plain collaborator that owns the ignore-list and exclude-pattern concern:
   * the per-file ignore set (files the user opted out of tracking) and the
   * path-exclude decision (a configured regexp that vetoes tracking for whole
   * folders), including the warn-once guard for an invalid pattern. Owned by the
   * service (not a DI service); reads the exclude pattern and routes the
   * invalid-pattern warning back through an {@link IgnoreListHost} port the
   * service builds.
   */
  protected ignoreList: IgnoreListManager = new IgnoreListManager(this.makeIgnoreListHost());

  /**
   * Plain collaborator that owns the external (off-editor) change detection
   * concern: the per-path debounce, the in-flight guard, the stat-based
   * last-seen pre-check, and the disk-read + hash-compare capture flow. Owned
   * by the service (not a DI service); reads the snapshot map and capture
   * gating back through an {@link ExternalChangeHost} port the service builds.
   */
  protected externalCapture: ExternalChangeCapture = new ExternalChangeCapture(this.makeExternalChangeHost());

  /**
   * Plain collaborator that owns the out-of-editor file-write concern: applying
   * a reverted block to a file (snapshot resync + disk write + editor refresh).
   * Owned by the service (not a DI service); reads the snapshot map and routes
   * the post-write forced update back through an {@link EditorOperationsHost}
   * port the service builds.
   */
  protected editorOperations: EditorOperations = new EditorOperations(this.makeEditorOperationsHost());

  /**
   * Creates a new instance of SnapshotsService.
   *
   * @param {LineChangeTrackerPlugin} plugin - The plugin instance
   */
  public constructor(
    protected plugin: LineChangeTrackerPlugin,
  ) {
  }

  /**
   * Initializes the service.
   * Sets up a subscription to emit an event when snapshots are updated.
   */
  public async init(): Promise<void> {
    this.fileSnapshots.subscribe((): void => {
      this.plugin.emit(PluginEvent.snapshotsUpdate);
    });
  }

  /**
   * Loads snapshots for all files in the workspace.
   * Called when the plugin is loaded.
   */
  public async load(): Promise<void> {
    for (const file of [...this.plugin.getWorkspaceFiles().values()]) {
      await this.capture(file);
    }
  }

  /**
   * Gets a snapshot for a specific file.
   * If no file is provided, use the active file.
   *
   * @param {TFile} file - The file to get the snapshot for, or null to use the active file
   * @return {FileSnapshot|null} The file snapshot, or null if no snapshot exists
   */
  public getOne(file?: TFile | null): FileSnapshot | null {
    const currentFile: TFile | null = file ?? this.plugin.getActiveFile();

    if (!currentFile) {
      return null;
    }

    return this.fileSnapshots.get(currentFile.path) ?? null;
  }

  /**
   * Gets all snapshots.
   *
   * @return {FileSnapshot[]} An array of all file snapshots
   */
  public getList(): FileSnapshot[] {
    return [...this.fileSnapshots.values()];
  }

  /**
   * Adds a new snapshot for the specified file.
   * Creates a FileSnapshot with the provided content and stores it in the map.
   *
   * @param {TFile} file - The file to create a snapshot for
   * @param {string} content - The content to snapshot
   */
  public add(file: TFile, content: string): void {
    if (!file) {
      return;
    }

    const lineBreak: string = this.plugin.getActiveEditorView()?.state.lineBreak;

    this.fileSnapshots.set(
      file.path,
      new FileSnapshot(content, lineBreak, file)
    );
  }

  /**
   * Removes the snapshot for the specified file.
   *
   * @param {TFile} file - The file whose snapshot should be removed
   */
  public remove(file: TFile): void {
    if (!file) {
      return;
    }

    this.fileSnapshots.delete(file.path);
    this.sessionCreatedPaths.delete(file.path);
    this.externalCapture.forget(file.path);
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
   * Marks the snapshot for the given file as a tombstone (D1) instead of
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

    const snapshot: FileSnapshot | undefined = this.fileSnapshots.get(file.path);

    if (!snapshot || snapshot.isTombstone()) {
      return;
    }

    snapshot.deletedTimestamp = Date.now();
    snapshot.lines = [];
    snapshot.tracker = [];
    snapshot.changes.clear();

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

    const snapshot: FileSnapshot | undefined = this.fileSnapshots.get(oldPath);

    if (!snapshot) {
      return;
    }

    snapshot.file = file;
    snapshot.path = file.path;

    this.fileSnapshots.delete(oldPath);
    this.fileSnapshots.set(file.path, snapshot);
    this.rekeySessionCreated(oldPath, file.path);
    this.externalCapture.forget(oldPath);
  }

  /**
   * Handles a cross-directory move (D2): leaves a tombstone at `oldPath` and
   * re-keys the live snapshot to the file's new path while stamping
   * `movedIntoAt` with the call timestamp. The live snapshot's history baseline,
   * version timeline, and current state travel with it so the file's captured
   * history is continuous through the move; the tombstone left behind carries
   * a full copy of those same fields so a folder view at the source prefix can
   * still surface the file as deleted with its history intact.
   *
   * This method is the move-only entry point: it asserts that `oldPath` and the
   * file's new path belong to different directories (per D3, an in-place rename
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
        `SnapshotsService.markMoved called without a directory change: ${oldPath} -> ${file.path}`,
      );
    }

    const snapshot: FileSnapshot | undefined = this.fileSnapshots.get(oldPath);

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
    const tombstone: FileSnapshot = new FileSnapshot('', snapshot.lineBreak);

    tombstone.file = null;
    tombstone.path = oldPath;
    tombstone.lines = [];
    tombstone.tracker = [];
    tombstone.changes.clear();
    tombstone.historyLines = snapshot.getHistoryOriginalStateLines();
    tombstone.updateState(snapshot.getLastStateLines());
    tombstone.versions = snapshot.versions.map(
      (version: FileVersion): FileVersion => FileVersion.fromJSON(version.toJSON()),
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

    this.fileSnapshots.delete(oldPath);
    this.fileSnapshots.set(file.path, snapshot);
    this.fileSnapshots.set(oldPath, tombstone);
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
   * Clears all snapshots from the service.
   * Removes all stored file snapshots.
   */
  public clear(): void {
    this.fileSnapshots.clear();
    this.sessionCreatedPaths.clear();
    this.externalCapture.clear();
  }

  /**
   * Serializes all tracked snapshots into a plain, persistable structure.
   * Includes live snapshots that carry actual history (a tracker with changes
   * or a non-empty intermediate-version timeline) so pristine files do not
   * bloat the store but a timeline is never lost just because the current
   * state happens to match the original. Tombstones (D1) are ALWAYS included
   * regardless of tracker/timeline emptiness: their final state plus
   * `deletedTimestamp` is the only record of a deleted file's content and must
   * survive a restart even when the live tracker was reset on `markDeleted`.
   *
   * The serialized `path` is taken from the map key (not from `snapshot.file`)
   * so tombstones whose `file` reference is null (cross-directory move leaves
   * a detached tombstone, D2) still round-trip to disk under their last-known
   * path.
   *
   * @return {SerializedHistory} The versioned, serializable history payload
   */
  public serialize(): SerializedHistory {
    const snapshots: SerializedFileSnapshot[] = [];

    for (const [path, snapshot] of this.fileSnapshots.entries()) {
      if (!path) {
        continue;
      }

      const isTombstone: boolean = snapshot.isTombstone();
      const hasHistory: boolean = snapshot.getChangesLinesCount() > 0 || snapshot.hasVersions();

      /**
       * Tombstones are kept unconditionally; live snapshots only when they
       * carry real history. The map key wins over snapshot.file?.path so a
       * detached tombstone (file = null) still serializes under its path.
       */
      if (!isTombstone && !hasHistory) {
        continue;
      }

      const payload: SerializedFileSnapshot = snapshot.toJSON();

      payload.path = path;

      snapshots.push(payload);
    }

    /**
     * Format version 2 signals "may contain delta entries" in versions[].
     * It is purely advisory: decode dispatches per entry on `lines` vs `delta`
     * (VersionCodec.decode), so version-1 (all-keyframe) and version-2
     * (delta-bearing) files restore identically and no reader branches on it.
     */
    return { version: 2, snapshots };
  }

  /**
   * Restores snapshots from a previously serialized history payload, keeping the
   * marker and history baselines separate (D2).
   *
   * When the file was already captured this session, its session snapshot owns
   * the MARKER baseline (the file content at this open) plus the live tracker and
   * state, which must stay session-scoped so the gutter does not mark the whole
   * file after a restart. The persisted HISTORY baseline and version timeline are
   * adopted into that session snapshot, so the modal still diffs against the
   * original and its captured versions without touching the markers.
   *
   * When the file is not open this session there is no session marker baseline to
   * preserve, so the snapshot is rebuilt verbatim (marker and history baselines
   * coincide).
   *
   * When the live file is gone (deleted while the plugin was off, or the entry
   * was already a tombstone on disk) the snapshot is reconstructed as a
   * tombstone under its persisted path so deleted-file history is never silently
   * dropped on restart:
   *
   *   - a payload that already carries `deletedTimestamp` is rebuilt as that
   *     same tombstone (the original deletion moment is preserved);
   *   - a live payload whose file no longer resolves is auto-tombstoned with
   *     `deletedTimestamp = data.timestamp`, treating the offline disappearance
   *     as a delete that happened at the snapshot's last-known moment.
   *
   * Auto-tombstoning runs from `restoreFromDisk`, which itself runs from
   * `onLayoutReady`, so the vault file index is fully populated by the time
   * `getFileByPath` is consulted; a null result is a real absence, not a
   * transient indexing miss.
   *
   * @param {SerializedFileSnapshot[]} snapshots - The serialized snapshots
   */
  public restore(snapshots: SerializedFileSnapshot[]): void {
    if (!Array.isArray(snapshots)) {
      return;
    }

    for (const data of snapshots) {
      if (!data?.path) {
        continue;
      }

      const file: TFile | null = this.plugin.getFileByPath(data.path);

      if (!file) {
        this.restoreOrphan(data);

        continue;
      }

      const existing: FileSnapshot | undefined = this.fileSnapshots.get(data.path);

      if (existing) {
        /**
         * Preserve the session marker baseline, tracker, and state; adopt only
         * the persisted history baseline and versions so the modal regains its
         * time machine while the gutter stays session-scoped.
         */
        const persisted: FileSnapshot = FileSnapshot.fromJSON(data, file);

        existing.adoptHistory(persisted.getHistoryOriginalStateLines(), persisted.versions);
        this.forceUpdate();

        continue;
      }

      /**
       * A file that exists but was not captured this session yet: reconstruct it
       * from disk, then collapse its session marker baseline onto the current
       * state so it starts session-clean. Without this the restored snapshot
       * carries its full history diff and the tree/tab decorator (which reads
       * snapshots without opening them) would paint its folder as changed on a
       * fresh launch, before the user edits anything this session.
       */
      const restored: FileSnapshot = FileSnapshot.fromJSON(data, file);

      restored.resetMarkerBaseline();
      this.fileSnapshots.set(data.path, restored);
    }
  }

  /**
   * Reconstructs a serialized entry whose live file is missing as a tombstone.
   * A payload that already carries `deletedTimestamp` is rebuilt verbatim so
   * the original deletion moment survives a restart; a live payload whose file
   * is gone is auto-tombstoned with `deletedTimestamp = data.timestamp` (the
   * snapshot's last-known moment), keeping deleted-file history accessible
   * even when the delete happened while the plugin was off.
   *
   * @param {SerializedFileSnapshot} data - The serialized snapshot
   */
  protected restoreOrphan(data: SerializedFileSnapshot): void {
    const snapshot: FileSnapshot = FileSnapshot.fromJSON(data, null);

    if (!snapshot.isTombstone()) {
      snapshot.deletedTimestamp = data.timestamp;
    }

    /**
     * Detach the file reference: the underlying TFile no longer exists, so the
     * tombstone must not pretend to point at a live vault entry.
     */
    snapshot.file = null;

    this.fileSnapshots.set(data.path, snapshot);
  }

  /**
   * Forces an update of the snapshots.
   * Triggers the observable map to notify subscribers.
   *
   * @return {void}
   */
  public forceUpdate(): void {
    return this.fileSnapshots.next(MapChangeAction.update);
  }

  /**
   * Adds a file to the ignore list.
   * Files in the ignore list will not have any changes tracked.
   *
   * @param {TFile} file - The file to add to the ignore list
   */
  public addToIgnoreList(file: TFile): void {
    this.ignoreList.add(file);
  }

  /**
   * Removes a file from the ignore list.
   * The file will be eligible for change tracking again.
   *
   * @param {TFile} file - The file to remove from the ignore list
   */
  public removeFromIgnoreList(file: TFile): void {
    this.ignoreList.remove(file);
  }

  /**
   * Checks if a file is in the ignore list.
   *
   * @param {TFile} file - The file to check
   * @return {boolean} True if the file is in the ignore list, false otherwise
   */
  public isInIgnoreList(file: TFile): boolean {
    return this.ignoreList.isIgnored(file);
  }

  /**
   * Clears all files from the ignore list.
   * All files will be eligible for change tracking again.
   */
  public clearIgnoreList(): void {
    this.ignoreList.clear();
  }

  /**
   * Gets all files currently in the ignore list.
   *
   * @return {TFile[]} An array of files in the ignore list
   */
  public getIgnoreList(): TFile[] {
    return this.ignoreList.list();
  }

  /**
   * Checks if a file is a plain text file based on its extension.
   * Accepts either a comma-separated string of extensions or an array of extensions.
   *
   * @param {TFile} file - The file to check
   * @return {boolean} True if the file is a plain text file, false otherwise
   */
  public isInAllowedExtensions(file: TFile): boolean {
    return this.settingsService.value('allowedExtensions')
      .split(',')
      .map((ext: string): string => ext.trim().toLowerCase())
      .includes(file.extension.toLowerCase());
  }

  /**
   * Checks whether a file path matches the configured exclude pattern.
   * Excluded paths (for example a templates or daily-notes folder) are never
   * tracked, on top of the extension filter. The pattern is a single
   * case-insensitive regexp matched against the vault-relative path; an empty
   * pattern excludes nothing. An invalid pattern excludes nothing and warns the
   * user once so a typo cannot silently disable all tracking.
   *
   * @param {TFile} file - The file to check
   * @return {boolean} True if the file path is excluded from tracking
   */
  public isExcludedPath(file: TFile): boolean {
    return this.ignoreList.isExcluded(file);
  }

  /**
   * Builds the narrow {@link IgnoreListHost} port the {@link IgnoreListManager}
   * reads its exclude-pattern dependency through. Exposes the raw exclude
   * pattern from settings and the one-time invalid-pattern warning, keeping
   * settings access and Notice construction owned by this service while the
   * manager owns the ignore set and the warn-once guard.
   *
   * @return {IgnoreListHost} The host port onto the exclude-pattern dependency
   */
  protected makeIgnoreListHost(): IgnoreListHost {
    return {
      getExcludePattern: (): string => this.settingsService.value('excludePaths'),
      notifyInvalidPattern: (): void => {
        new Notice(this.plugin.t('notice.invalid-exclude-pattern'));
      },
    };
  }

  /**
   * Checks if a file has already been captured (has a snapshot).
   *
   * @param {TFile} file - The file to check
   * @return {boolean} True if the file has been captured, false otherwise
   */
  public isCaptured(file: TFile): boolean {
    if (!file) {
      return false;
    }

    return this.fileSnapshots.has(file.path);
  }

  /**
   * Determines if a file can be captured for change tracking.
   * A file can be captured if it has an allowed extension, its path is not
   * excluded by a configured pattern, it hasn't been captured yet, and it is not
   * in the ignore list.
   *
   * @param {TFile} file - The file to check
   * @return {boolean} True if the file can be captured, false otherwise
   */
  public canCapture(file: TFile): boolean {
    if (!file) {
      return false;
    }

    const isExtensionAllowed: boolean = this.isInAllowedExtensions(file);
    const isExcluded: boolean = this.isExcludedPath(file);
    const isHasInList: boolean = this.isCaptured(file);
    const isIgnored: boolean = this.isInIgnoreList(file);

    return isExtensionAllowed && !isExcluded && !isHasInList && !isIgnored;
  }

  /**
   * Creates a snapshot for a file.
   * If no file is provided, use the active file.
   * Only captures files that match the configured extensions and don't already have a snapshot.
   *
   * @param {TFile} file - The file to capture, or null to use the active file
   */
  public async capture(file?: TFile | null): Promise<void> {
    const currentFile: TFile | null = file ?? this.plugin.getActiveFile();

    if (!currentFile || !this.canCapture(currentFile)) {
      return;
    }

    try {
      const content: string = await this.plugin.app.vault.read(currentFile);
      this.add(currentFile, content);
    } catch (error) {
      console.error('Error capturing file snapshot:', error);
    }
  }

  /**
   * Captures an external (off-editor) change to a tracked file as a flagged
   * version on its timeline (D12/D13). Delegates to the
   * {@link ExternalChangeCapture} collaborator, which reads the file from disk,
   * compares it to the snapshot's known state, and force-captures a divergent
   * external version while filtering out editor flushes, the plugin's own
   * revert writes, tombstones, ignored/excluded/wrong-extension files, and
   * unchanged content (ADR-08-D/E).
   *
   * @param {TFile | null} file - The file whose disk content changed
   * @return {Promise<void>} Resolves once the external capture completes
   */
  public captureExternalChange(file?: TFile | null): Promise<void> {
    return this.externalCapture.capture(file);
  }

  /**
   * Public entry point for the vault.modify handler. Delegates to the
   * {@link ExternalChangeCapture} collaborator, which coalesces a burst of
   * modify events for the same path through a per-path debounce, then runs the
   * external capture once under an in-flight guard so an overlapping follow-up
   * modify cannot double-capture the same disk state (ADR-08-E).
   *
   * @param {TFile} file - The file whose modify event fired
   */
  public scheduleExternalCapture(file: TFile): void {
    this.externalCapture.schedule(file);
  }

  /**
   * Builds the narrow {@link ExternalChangeHost} port the
   * {@link ExternalChangeCapture} collaborator reads its shared state through.
   * Exposes the plugin, the snapshot lookup, the external-capture gating, the
   * first-sight capture, the capture cadence options, and the forced update,
   * keeping the snapshot map and CRUD owned by this service while the
   * collaborator owns the debounce/in-flight/last-seen machinery.
   *
   * @return {ExternalChangeHost} The host port onto the snapshot state
   */
  protected makeExternalChangeHost(): ExternalChangeHost {
    return {
      plugin: this.plugin,
      getSnapshot: (path: string): FileSnapshot | undefined => this.fileSnapshots.get(path),
      isExternallyCapturable: (file: TFile): boolean =>
        this.isInAllowedExtensions(file) && !this.isExcludedPath(file) && !this.isInIgnoreList(file),
      captureFirstSight: (file: TFile): Promise<void> => this.capture(file),
      getCaptureOptions: (): SnapshotCaptureOptions => this.getCaptureOptions(),
      forceUpdate: (): void => this.forceUpdate(),
    };
  }

  /**
   * Reads the current capture cadence and retention caps into a plain options
   * object for the snapshot model. Mirrors the helper in change-detector and
   * version-actions so eviction stays aligned across every capture source.
   *
   * @return {SnapshotCaptureOptions} The capture cadence configuration
   */
  protected getCaptureOptions(): SnapshotCaptureOptions {
    return {
      enabled: this.settingsService.value('snapshots.enabled'),
      intervalMs: this.settingsService.value('snapshots.intervalMs'),
      editThreshold: this.settingsService.value('snapshots.editThreshold'),
      maxVersions: this.settingsService.value('snapshots.maxVersions'),
      maxVersionAgeDays: this.settingsService.value('snapshots.maxVersionAgeDays'),
    };
  }

  /**
   * Removes a snapshot for a specific file.
   * If no file is provided, use the active file.
   * Forces an editor update and recaptures the file if it's the active file.
   *
   * @param {TFile} file - The file to remove the snapshot for, or null to use the active file
   */
  public wipeOne(file?: TFile | null): void {
    const current: TFile | null = this.plugin.getActiveFile();
    const target: TFile | null = file ?? current;

    if (target) {
      this.remove(target);
      this.removeFromIgnoreList(target);
    }

    if (this.plugin.getActiveViewOfType()) {
      this.plugin.forceUpdateEditor();
    }

    if (current && (!file || file.path === current.path)) {
      /**
       * The cleared snapshot belongs to the file the user is still viewing, so
       * re-capture it immediately to start a fresh baseline for that file.
       */
      void this.capture();
    }
  }

  /**
   * Applies an out-of-editor content change to a file and keeps its snapshot in
   * sync, preserving the original baseline and the version timeline. Used by the
   * history modal to revert a single hunk. Delegates to the
   * {@link EditorOperations} collaborator, which rewrites the changed block in
   * the tracker, sets the cached state to the written content, refreshes the
   * derived changes, then writes the new content to disk and refreshes the
   * editor (the snapshot is updated before the file write so the change detector
   * skips reprocessing the resulting editor update).
   *
   * @param {TFile | null} file - The file to rewrite
   * @param {string[]} lines - The full new content of the file as lines
   * @param {EditorBlock} block - The single block that changed, in tracker terms
   * @return {Promise<boolean>} True if the change was applied, false otherwise
   */
  public applyContent(
    file: TFile | null,
    lines: string[],
    block: EditorBlock,
  ): Promise<boolean> {
    return this.editorOperations.applyContent(file, lines, block);
  }

  /**
   * Builds the narrow {@link EditorOperationsHost} port the
   * {@link EditorOperations} collaborator reads its shared state through.
   * Exposes the plugin (for the disk write and the active-view check), the
   * snapshot lookup, and the forced update, keeping the snapshot map and CRUD
   * owned by this service while the collaborator owns the file-write flow.
   *
   * @return {EditorOperationsHost} The host port onto the snapshot state
   */
  protected makeEditorOperationsHost(): EditorOperationsHost {
    return {
      plugin: this.plugin,
      getSnapshot: (file?: TFile | null): FileSnapshot | null => this.getOne(file),
      forceUpdate: (): void => this.forceUpdate(),
    };
  }

  /**
   * Removes all snapshots.
   * Forces an editor update and captures the active file.
   */
  public wipe(): void {
    this.clear();
    this.clearIgnoreList();

    if (this.plugin.getActiveViewOfType()) {
      this.plugin.forceUpdateEditor();
    }

    void this.capture();
  }
}
