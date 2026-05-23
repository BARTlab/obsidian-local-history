import { MapChangeAction, PluginEvent } from '@/consts';
import { Inject } from '@/decorators/inject.decorator';
import { PathExcludeHelper } from '@/helpers/path-exclude.helper';
import { PathHelper } from '@/helpers/path.helper';
import type LineChangeTrackerPlugin from '@/main';
import { ObservableMap } from '@/maps/observable.map';
import type { SettingsService } from '@/services/settings.service';
import { FileSnapshot } from '@/snapshots/file.snapshot';
import { FileVersion } from '@/snapshots/file.version';
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
   * Set of files to ignore when capturing snapshots.
   * Files in this list will not have any changes tracked.
   */
  protected ignoreList: Set<TFile> = new Set();

  /**
   * The last exclude pattern a user was warned about for being invalid. Keeps
   * the "invalid regexp" Notice from firing on every captured file: the warning
   * shows once per distinct bad pattern until the user edits the field to a
   * valid one (or to a different bad one).
   */
  protected lastWarnedExcludePattern: string | null = null;

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
    const currentFile: TFile = file ?? this.plugin.getActiveFile();

    return this.fileSnapshots.get(currentFile?.path) ?? null;
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

    this.fileSnapshots.delete(oldPath);
    this.fileSnapshots.set(file.path, snapshot);
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
    snapshot.movedIntoAt = now;

    this.fileSnapshots.delete(oldPath);
    this.fileSnapshots.set(file.path, snapshot);
    this.fileSnapshots.set(oldPath, tombstone);
  }

  /**
   * Clears all snapshots from the service.
   * Removes all stored file snapshots.
   */
  public clear(): void {
    this.fileSnapshots.clear();
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

    return { version: 1, snapshots };
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

      this.fileSnapshots.set(data.path, FileSnapshot.fromJSON(data, file));
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
    if (!file) {
      return;
    }

    this.ignoreList.add(file);
  }

  /**
   * Removes a file from the ignore list.
   * The file will be eligible for change tracking again.
   *
   * @param {TFile} file - The file to remove from the ignore list
   */
  public removeFromIgnoreList(file: TFile): void {
    if (!file) {
      return;
    }

    this.ignoreList.delete(file);
  }

  /**
   * Checks if a file is in the ignore list.
   *
   * @param {TFile} file - The file to check
   * @return {boolean} True if the file is in the ignore list, false otherwise
   */
  public isInIgnoreList(file: TFile): boolean {
    if (!file) {
      return false;
    }

    return this.ignoreList.has(file);
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
    return [...this.ignoreList];
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
    if (!file) {
      return false;
    }

    const pattern: string = this.settingsService.value('excludePaths');

    this.warnOnInvalidExcludePattern(pattern);

    return PathExcludeHelper.isExcluded(file.path, pattern);
  }

  /**
   * Shows a one-time Notice when the exclude pattern does not compile, so the
   * user learns their regexp is ignored without being spammed once per file.
   * Resets the guard when the pattern becomes valid again, so a later mistake is
   * surfaced afresh.
   *
   * @param {string} pattern - The raw exclude pattern from settings
   */
  protected warnOnInvalidExcludePattern(pattern: string): void {
    if (PathExcludeHelper.isValid(pattern)) {
      this.lastWarnedExcludePattern = null;

      return;
    }

    if (this.lastWarnedExcludePattern === pattern) {
      return;
    }

    this.lastWarnedExcludePattern = pattern;

    new Notice(this.plugin.t('notice.invalid-exclude-pattern'));
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
    const currentFile: TFile = file ?? this.plugin.getActiveFile();

    if (!this.canCapture(currentFile)) {
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
   * version on its timeline (D12/D13). Reads the file from disk, compares its
   * content hash to the snapshot's known `state`, and force-captures the new
   * content as a `FileVersion` with `external = true` only when the hash
   * diverges, then updates `state`/tracker/changes so further reads see the
   * captured content as the new baseline.
   *
   * Gating mirrors the parts of `canCapture` that still apply when a snapshot
   * already exists: a wrong-extension file, an excluded path, an ignored file,
   * or a missing/folder TFile is a no-op. A hash match is also a no-op so
   * editor-driven flushes and the plugin's own revert writes (which already
   * synchronized `state` before/after the write) do not produce phantom
   * external versions.
   *
   * A first-sight file (no snapshot yet) is captured as a normal snapshot via
   * `capture`, without an `external` version: there is no prior state to diff
   * against, so flagging the very first capture would mislabel a brand-new
   * file as an external change.
   *
   * A tombstone entry is a no-op: a tombstone represents a deleted file at
   * that path and `vault.modify` should not legitimately fire there; the
   * resurrection flow belongs to a future `vault.create` handler, not here.
   *
   * The capture is forced past the cadence gates so every distinct external
   * state lands as its own version (D13), but it is NOT pinned: the resulting
   * version obeys the normal age/count retention exactly like a cadence one,
   * so a chatty sync workflow cannot bloat `history.json` with un-evictable
   * entries.
   *
   * @param {TFile | null} file - The file whose disk content changed
   */
  public async captureExternalChange(file?: TFile | null): Promise<void> {
    if (!file) {
      return;
    }

    if (!this.isInAllowedExtensions(file)) {
      return;
    }

    if (this.isExcludedPath(file)) {
      return;
    }

    if (this.isInIgnoreList(file)) {
      return;
    }

    const snapshot: FileSnapshot | undefined = this.fileSnapshots.get(file.path);

    if (!snapshot) {
      await this.capture(file);

      return;
    }

    /**
     * A tombstone at this path means our model thinks the file is gone; a
     * legitimate modify should never reach this point, and a resurrection is
     * not an "external change" semantically. Leave the tombstone alone so the
     * history modal still surfaces the file's last-known state.
     */
    if (snapshot.isTombstone()) {
      return;
    }

    let content: string;

    try {
      content = await this.plugin.app.vault.read(file);
    } catch (error) {
      console.error('Error reading file for external change capture:', error);

      return;
    }

    if (!snapshot.isNeedUpdate(content)) {
      return;
    }

    const newLines: string[] = content.split(snapshot.lineBreak);
    const captured: FileVersion | null = snapshot.captureVersion(newLines, this.getCaptureOptions(), true);

    if (captured) {
      /**
       * The version captures the NEW disk content as a discrete point on the
       * timeline (D13: every distinct external state lands as its own version).
       * Setting the flag after capture keeps file.snapshot.ts free of an
       * external-aware overload and still flows through the normal eviction
       * pipeline, so external versions remain evictable like cadence ones.
       */
      captured.external = true;
    }

    /**
     * Bring the tracker in line with the new content the same way applyContent
     * does for the per-hunk revert path: rewrite the whole current span as a
     * single block, then refresh the cached state and change map. Without this,
     * the tracker would still describe the pre-change content and the gutter
     * markers would drift out of sync with what the user sees in the editor.
     */
    const previousLength: number = snapshot.state.length;

    snapshot.replaceBlock(0, previousLength, newLines);
    snapshot.updateState(newLines);
    snapshot.updateChanges();

    this.forceUpdate();
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
    const current: TFile = this.plugin.getActiveFile();

    this.remove(file ?? current);
    this.removeFromIgnoreList(file ?? current);

    if (this.plugin.getActiveViewOfType()) {
      this.plugin.forceUpdateEditor();
    }

    if (current && (!file || file?.path === current.path)) {
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
   * history modal to revert a single hunk: the block is rewritten in the tracker
   * (so highlights stay correct even for a file that is not the active editor),
   * the cached state is set to the written content, and the file is modified on
   * disk.
   *
   * The snapshot is updated before the file write so that, when the file is the
   * active editor, the change detector sees a matching content hash and skips
   * reprocessing the resulting editor update (no double application).
   *
   * @param {TFile} file - The file to rewrite
   * @param {string[]} lines - The full new content of the file as lines
   * @param {object} block - The single block that changed, in tracker terms
   * @param {number} block.start - The 0-based current line where the block begins
   * @param {number} block.removeCount - How many current lines the block spans
   * @param {string[]} block.newLines - The content the block should hold afterwards
   * @return {Promise<boolean>} True if the change was applied, false otherwise
   */
  public async applyContent(
    file: TFile | null,
    lines: string[],
    block: { start: number; removeCount: number; newLines: string[] },
  ): Promise<boolean> {
    const snapshot: FileSnapshot | null = this.getOne(file);

    if (!file || !snapshot || !Array.isArray(lines)) {
      return false;
    }

    snapshot.replaceBlock(block.start, block.removeCount, block.newLines);
    snapshot.updateState(lines);
    snapshot.updateChanges();

    await this.plugin.app.vault.modify(file, lines.join(snapshot.lineBreak));

    if (this.plugin.getActiveViewOfType()) {
      this.plugin.forceUpdateEditor();
    }

    this.forceUpdate();

    return true;
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
