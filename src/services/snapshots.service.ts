import { PluginEvent } from '@/consts';
import { Inject } from '@/decorators/inject.decorator';
import type LineChangeTrackerPlugin from '@/main';
import { ObservableMap } from '@/maps/observable.map';
import type { SettingsService } from '@/services/settings.service';
import { FileSnapshot } from '@/snapshots/file.snapshot';
import type { Service } from '@/types';
import type { TFile } from 'obsidian';

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
   * Clears all snapshots from the service.
   * Removes all stored file snapshots.
   */
  public clear(): void {
    this.fileSnapshots.clear();
  }

  /**
   * Forces an update of the snapshots.
   * Triggers the observable map to notify subscribers.
   *
   * @return {void}
   */
  public forceUpdate(): void {
    return this.fileSnapshots.next('update');
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
   * A file can be captured if it has an allowed extension, hasn't been captured yet,
   * and is not in the ignore list.
   *
   * @param {TFile} file - The file to check
   * @return {boolean} True if the file can be captured, false otherwise
   */
  public canCapture(file: TFile): boolean {
    if (!file) {
      return false;
    }

    const isExtensionAllowed: boolean = this.isInAllowedExtensions(file);
    const isHasInList: boolean = this.isCaptured(file);
    const isIgnored: boolean = this.isInIgnoreList(file);

    return isExtensionAllowed && !isHasInList && !isIgnored;
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
      // const lineBreak: string = this.plugin.getActiveEditorView()?.state.lineBreak;

      // todo: remove lines store?
      // const snapshot: FileSnapshot = new FileSnapshot(content, lineBreak, currentFile);

      // this.fileSnapshots.set(currentFile.path, snapshot);
      this.add(currentFile, content)
    } catch (error) {
      console.error('Error capturing file snapshot:', error);
    }
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
      // If the current open file was cleared, most likely we are still in focused reading it again
      void this.capture();
    }
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
