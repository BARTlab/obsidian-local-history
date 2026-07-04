import { PluginEvent } from '@/consts';
import { Inject } from '@/decorators/inject.decorator';
import { PathExcludeHelper } from '@/helpers/path-exclude.helper';
import type LineChangeTrackerPlugin from '@/main';
import { ExternalChangeCapture } from '@/snapshots/external-change-capture';
import type { ExternalChangeHost } from '@/snapshots/external-change-capture.types';
import type { SettingsService } from '@/services/settings.service';
import { TOKENS } from '@/services/tokens';
import { EditorOperations } from '@/snapshots/editor-operations';
import type { EditorOperationsHost } from '@/snapshots/editor-operations.types';
import type { FileSnapshot } from '@/snapshots/file.snapshot';
import { HistorySerializer } from '@/snapshots/history-serializer';
import type { HistorySerializerHost } from '@/snapshots/history-serializer.types';
import { IgnoreListManager } from '@/snapshots/ignore-list';
import type { IgnoreListHost } from '@/snapshots/ignore-list.types';
import { SnapshotRegistry } from '@/snapshots/snapshot-registry';
import type { SnapshotRegistryHost } from '@/snapshots/snapshot-registry.types';
import type { EditorBlock, SerializedFileSnapshot, SerializedHistory, Service, SnapshotCaptureOptions } from '@/types';
import { Notice, type TFile } from 'obsidian';

/**
 * Service responsible for managing file snapshots.
 * Tracks file content changes and provides methods to capture, retrieve, and manage snapshots.
 *
 * @implements {Service}
 */
export class SnapshotsService implements Service {
  /**
   * Plain collaborator that owns the ignore-list and exclude-pattern concern:
   * the per-file ignore set (files the user opted out of tracking) and the
   * path-exclude decision (a configured regexp that vetoes tracking for whole
   * folders), including the warn-once guard for an invalid pattern. Owned by the
   * service (not a DI service); reads the exclude pattern and routes the
   * invalid-pattern warning back through an {@link IgnoreListHost} port the
   * service builds.
   *
   * Exposed publicly as the single accessor for the manual ignore-list
   * operations (add/remove/isIgnored/clear/list): callers reach it directly
   * instead of through per-method service pass-throughs. The path-exclude
   * decision stays behind {@link isExcludedPath} so capture-policy callers do
   * not have to know exclusion is co-located on this collaborator.
   */
  public readonly ignoreList: IgnoreListManager = new IgnoreListManager(this.makeIgnoreListHost());

  @Inject(TOKENS.settings)
  protected settingsService!: SettingsService;

  /**
   * Plain collaborator that owns the path-keyed registry concern: the observable
   * map of paths to snapshots, the transient session-created path set, and the
   * add/remove/rename/move/tombstone/rekey rules that keep those two in step.
   * Owned by the service (not a DI service); reads the active editor line break
   * and routes the external-capture forget back through a
   * {@link SnapshotRegistryHost} port the service builds.
   */
  protected registry: SnapshotRegistry = new SnapshotRegistry(this.makeSnapshotRegistryHost());

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
   * Plain collaborator that owns the history serialization concern: turning the
   * tracked snapshots into a persistable payload and rebuilding them from one,
   * including tombstone inclusion, the session-marker-baseline preservation on
   * re-open, the orphan (missing-file) reconstruction, and the post-restore
   * open-file reconcile pass. Owned by the service (not a DI service); works
   * against the {@link SnapshotRegistry} and reaches the plugin (file lookup,
   * open files, external-capture scheduling) through a
   * {@link HistorySerializerHost} port the service builds.
   */
  protected historySerializer: HistorySerializer =
    new HistorySerializer(this.registry, this.makeHistorySerializerHost());

  /**
   * Creates a new instance of SnapshotsService.
   *
   * @param {LineChangeTrackerPlugin} plugin - The plugin instance
   */
  public constructor(
    public plugin: LineChangeTrackerPlugin,
  ) {
  }

  /**
   * Initializes the service.
   * Sets up a subscription to emit an event when snapshots are updated.
   */
  public async init(): Promise<void> {
    this.registry.subscribe((): void => {
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

    return this.registry.get(currentFile.path) ?? null;
  }

  /**
   * Gets all snapshots.
   *
   * @return {FileSnapshot[]} An array of all file snapshots
   */
  public getList(): FileSnapshot[] {
    return this.registry.getAll();
  }

  /**
   * Adds a new snapshot for the specified file. Delegates to the
   * {@link SnapshotRegistry}, which builds a FileSnapshot with the detected line
   * break and stores it under the file's path.
   *
   * @param {TFile} file - The file to create a snapshot for
   * @param {string} content - The content to snapshot
   */
  public add(file: TFile, content: string): void {
    this.registry.add(file, content);
  }

  /**
   * Removes the snapshot for the specified file. Delegates to the
   * {@link SnapshotRegistry}, which drops the map entry, the session-created
   * mark, and the external-capture state for the path.
   *
   * @param {TFile} file - The file whose snapshot should be removed
   */
  public remove(file: TFile): void {
    this.registry.remove(file);
  }

  /**
   * Records that `path` was created by the user this session so the tree/tab
   * decorator can paint it as "added" even when the "ignore new files" setting
   * suppressed its snapshot. Called by the `vault.create` handler. Delegates to
   * the {@link SnapshotRegistry}, which owns the transient session-created set.
   *
   * @param {string} path - The vault-relative path of the created file
   */
  public markCreatedThisSession(path: string): void {
    this.registry.markCreatedThisSession(path);
  }

  /**
   * The set of vault paths created by the user this session. Read by the
   * tree/tab decorator to tint created files as "added" independently of whether
   * a snapshot exists for them.
   *
   * @return {ReadonlySet<string>} The session-created paths
   */
  public getSessionCreatedPaths(): ReadonlySet<string> {
    return this.registry.getSessionCreatedPaths();
  }

  /**
   * Marks the snapshot for the given file as a tombstone instead of dropping it,
   * preserving its history so a deleted file can still be reconstructed.
   * Delegates to the {@link SnapshotRegistry}, which owns the tombstone rules.
   *
   * @param {TFile} file - The file that was deleted in the vault
   */
  public markDeleted(file: TFile): void {
    this.registry.markDeleted(file);
  }

  /**
   * Re-keys a snapshot after an in-place rename (same directory), preserving the
   * tracked history across the rename. Delegates to the {@link SnapshotRegistry},
   * which owns the re-key rules.
   *
   * @param {string} oldPath - The path the snapshot was previously keyed by
   * @param {TFile} file - The file in its renamed state (holding the new path)
   */
  public rename(oldPath: string, file: TFile): void {
    this.registry.rename(oldPath, file);
  }

  /**
   * Handles a cross-directory move: leaves a tombstone at `oldPath` and re-keys
   * the live snapshot to the file's new path, stamping `movedIntoAt`. Delegates
   * to the {@link SnapshotRegistry}, which owns the move/tombstone rules.
   *
   * @param {string} oldPath - The path the snapshot was previously keyed by
   * @param {TFile} file - The file in its moved state (holding the new path)
   */
  public markMoved(oldPath: string, file: TFile): void {
    this.registry.markMoved(oldPath, file);
  }

  /**
   * Clears all snapshots from the service. The {@link SnapshotRegistry} clears
   * the snapshot map and the session-created marks; the external-capture state
   * is reset here since the service composes both collaborators.
   */
  public clear(): void {
    this.registry.clear();
    this.externalCapture.clear();
  }

  /**
   * Serializes all tracked snapshots into a plain, persistable structure.
   * Delegates to the {@link HistorySerializer}, which owns the serialization
   * rules (which snapshots to keep, tombstone inclusion, per-file failure
   * isolation, and the advisory format version).
   *
   * @return {SerializedHistory} The versioned, serializable history payload
   */
  public serialize(): SerializedHistory {
    return this.historySerializer.serialize();
  }

  /**
   * Restores snapshots from a previously serialized history payload. Delegates
   * to the {@link HistorySerializer}, which owns the restore rules: preserving
   * the session marker baseline while adopting the persisted history, rebuilding
   * unopened files session-clean, reconstructing missing files as tombstones,
   * and reconciling the open files against disk afterward.
   *
   * @param {SerializedFileSnapshot[]} snapshots - The serialized snapshots
   */
  public restore(snapshots: SerializedFileSnapshot[]): void {
    this.historySerializer.restore(snapshots);
  }

  /**
   * Forces an update of the snapshots. Delegates to the {@link SnapshotRegistry},
   * which triggers the observable map to notify subscribers.
   */
  public forceUpdate(): void {
    this.registry.forceUpdate();
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
   * Checks whether a file path matches any configured exclude pattern.
   * Excluded paths (for example a templates or daily-notes folder) are never
   * tracked, on top of the extension filter. The patterns are case-insensitive
   * regexps matched against the vault-relative path and OR'd together; an empty
   * list excludes nothing. An invalid entry excludes nothing and warns the user
   * once so a typo cannot silently disable all tracking.
   *
   * @param {TFile} file - The file to check
   * @return {boolean} True if the file path is excluded from tracking
   */
  public isExcludedPath(file: TFile): boolean {
    return this.isOwnPluginPath(file.path) || this.ignoreList.isExcluded(file);
  }

  /**
   * Path-based mirror of {@link isExcludedPath} for callers that hold only a
   * vault-relative path and no live `TFile` (the tree decorator reconciling
   * folder tints after a reload, where a restored snapshot may have no file yet).
   * A path is excluded when it sits inside the plugin's own data directory or
   * matches any configured exclude pattern, using the same patterns and
   * case-sensitivity as capture. Skips the once-per-bad-list invalid-pattern
   * warning, which the capture path already surfaces.
   *
   * @param {string} path - The vault-relative path to test
   * @return {boolean} True when the path is excluded from tracking
   */
  public isPathExcluded(path: string): boolean {
    return this.isOwnPluginPath(path) || PathExcludeHelper.isExcluded(
      path,
      this.settingsService.value('excludePaths'),
      this.settingsService.value('excludePathsCaseSensitive'),
    );
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

    return this.registry.has(file.path);
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
    const isIgnored: boolean = this.ignoreList.isIgnored(file);

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
   * version on its timeline. Delegates to the
   * {@link ExternalChangeCapture} collaborator, which reads the file from disk,
   * compares it to the snapshot's known state, and force-captures a divergent
   * external version while filtering out editor flushes, the plugin's own
   * revert writes, tombstones, ignored/excluded/wrong-extension files, and
   * unchanged content.
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
   * modify cannot double-capture the same disk state.
   *
   * @param {TFile} file - The file whose modify event fired
   */
  public scheduleExternalCapture(file: TFile): void {
    this.externalCapture.schedule(file);
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
      this.ignoreList.remove(target);
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
   * Deletes every snapshot whose path currently matches the configured exclude
   * pattern. Live snapshots AND tombstones are both considered: a tombstone for
   * an excluded path is equally unwanted. Paths that no longer match the exclude
   * pattern, or where no snapshot exists, are left untouched.
   *
   * After the purge, the caller receives the number of entries removed via the
   * return value so the settings UI can display a feedback Notice with an
   * accurate count (including the zero case).
   *
   * Session-created marks and the external-capture state are dropped for each
   * purged path to keep the in-memory caches consistent with the snapshot map.
   *
   * @return {number} The number of snapshots deleted
   */
  public purgeExcluded(): number {
    const excludePatterns: string[] = this.settingsService.value('excludePaths');
    const caseSensitive: boolean = this.settingsService.value('excludePathsCaseSensitive');
    const pathsToPurge: string[] = [];

    for (const [path] of this.registry.entries()) {
      if (path && PathExcludeHelper.isExcluded(path, excludePatterns, caseSensitive)) {
        pathsToPurge.push(path);
      }
    }

    for (const path of pathsToPurge) {
      this.registry.deleteByPath(path);
      this.externalCapture.forget(path);
    }

    if (pathsToPurge.length > 0) {
      this.forceUpdate();
    }

    return pathsToPurge.length;
  }

  /**
   * Removes all snapshots.
   * Forces an editor update and captures the active file.
   */
  public wipe(): void {
    this.clear();
    this.ignoreList.clear();

    if (this.plugin.getActiveViewOfType()) {
      this.plugin.forceUpdateEditor();
    }

    void this.capture();
  }

  /**
   * Whether a vault path lives inside the plugin's own folder (its history
   * shards, `data.json`, and any other plugin data). Such a path is NEVER
   * tracked: capturing a shard would record the plugin's own output as a note,
   * and since each save rewrites a shard that then looks like a new change, the
   * plugin would build a history-of-its-own-history that balloons the store
   * save over save. The check compares the vault-relative path against the
   * manifest dir (falling back to `<configDir>/plugins/<id>` when the manifest
   * carries no dir), matching the folder itself and everything beneath it. It
   * degrades to `false` when no plugin dir can be resolved, so a bare test stub
   * or an unusual host cannot crash the trackable decision.
   *
   * @param {string} path - The vault-relative path to test
   * @return {boolean} True when the path is inside the plugin's own directory
   */
  protected isOwnPluginPath(path: string): boolean {
    const configDir: string | undefined = this.plugin.app?.vault?.configDir;
    const dir: string | undefined = this.plugin.manifest?.dir
      ?? (configDir ? `${configDir}/plugins/${this.plugin.manifest?.id ?? ''}` : undefined);

    if (!dir) {
      return false;
    }

    return path === dir || path.startsWith(`${dir}/`);
  }

  /**
   * Builds the narrow {@link HistorySerializerHost} port the
   * {@link HistorySerializer} reads its plugin-facing dependencies through: the
   * vault file lookup (to resolve a persisted path to a live file), the open
   * files (for the post-restore reconcile pass, empty when the plugin does not
   * expose them), and the external-capture scheduling, keeping the plugin handle
   * and the sibling collaborators owned by this service.
   *
   * @return {HistorySerializerHost} The host port onto the serializer's deps
   */
  protected makeHistorySerializerHost(): HistorySerializerHost {
    return {
      getFileByPath: (path: string): TFile | null => this.plugin.getFileByPath(path),
      getOpenFiles: (): Set<TFile> =>
        typeof this.plugin.getWorkspaceFiles === 'function' ? this.plugin.getWorkspaceFiles() : new Set<TFile>(),
      scheduleExternalCapture: (file: TFile): void => this.scheduleExternalCapture(file),
    };
  }

  /**
   * Builds the narrow {@link SnapshotRegistryHost} port the
   * {@link SnapshotRegistry} reads its two outside dependencies through: the
   * active editor's line break (so a captured snapshot matches the editor) and
   * the external-capture forget (so a removed or relocated path leaves no stale
   * capture state), keeping the plugin handle and the sibling collaborators
   * owned by this service.
   *
   * @return {SnapshotRegistryHost} The host port onto the registry's outside deps
   */
  protected makeSnapshotRegistryHost(): SnapshotRegistryHost {
    return {
      getActiveEditorLineBreak: (): string | undefined => this.plugin.getActiveEditorView()?.state.lineBreak,
      forgetExternalCapture: (path: string): void => this.externalCapture.forget(path),
    };
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
      getExcludePatterns: (): string[] => this.settingsService.value('excludePaths'),
      getExcludePathsCaseSensitive: (): boolean => this.settingsService.value('excludePathsCaseSensitive'),
      notifyInvalidPattern: (): void => {
        new Notice(this.plugin.t('notice.invalid-exclude-pattern'));
      },
    };
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
      getSnapshot: (path: string): FileSnapshot | undefined => this.registry.get(path),
      isExternallyCapturable: (file: TFile): boolean =>
        this.isInAllowedExtensions(file) && !this.isExcludedPath(file) && !this.ignoreList.isIgnored(file),
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
}
