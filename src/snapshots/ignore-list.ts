import { PathExcludeHelper } from '@/helpers/path-exclude.helper';
import type { TFile } from 'obsidian';

/**
 * Host port the {@link IgnoreListManager} reads its exclude-pattern dependency
 * through. The manager owns the ignore-list set and the warn-once guard but
 * stays free of the settings service and the Obsidian {@link Notice}: it asks
 * the host for the current exclude pattern and, on an invalid one, routes the
 * one-time user warning back through the host so the {@link SnapshotsService}
 * keeps sole ownership of settings access and toast construction.
 */
export interface IgnoreListHost {
  /**
   * The raw, user-configured exclude pattern from settings. A single
   * case-insensitive regexp matched against the vault-relative path; an empty
   * pattern excludes nothing.
   *
   * @return {string} The current exclude pattern
   */
  getExcludePattern(): string;

  /**
   * Shows the user a one-time toast that their exclude pattern is malformed and
   * therefore ignored. Routed through the host so the manager does not depend on
   * the plugin's i18n or the Obsidian Notice; the warn-once gating lives in the
   * manager so the host is called at most once per distinct bad pattern.
   */
  notifyInvalidPattern(): void;
}

/**
 * Plain collaborator that owns the ignore-list and exclude-pattern concern of
 * {@link SnapshotsService}: the per-file ignore set (files the user opted out of
 * tracking) and the path-exclude decision (a configured regexp that vetoes
 * tracking for whole folders), including the warn-once guard that surfaces an
 * invalid pattern to the user exactly once per distinct bad value.
 *
 * It is instantiated and owned by the service (not a DI service), so the DI
 * container's `constructor.name` resolution and registration ordering are
 * untouched. It reads the exclude pattern and routes the invalid-pattern warning
 * through a narrow {@link IgnoreListHost} port, keeping the service the sole
 * owner of settings access and Notice construction.
 */
export class IgnoreListManager {
  /**
   * Set of files to ignore when capturing snapshots. Files in this set will not
   * have any changes tracked.
   */
  protected ignoreList: Set<TFile> = new Set();

  /**
   * The last exclude pattern a user was warned about for being invalid. Keeps
   * the "invalid regexp" warning from firing on every captured file: the warning
   * shows once per distinct bad pattern until the user edits the field to a
   * valid one (or to a different bad one).
   */
  protected lastWarnedExcludePattern: string | null = null;

  /**
   * Creates a new IgnoreListManager bound to its owning service's host port.
   *
   * @param {IgnoreListHost} host - The narrow port onto the exclude pattern
   */
  public constructor(
    protected host: IgnoreListHost,
  ) {
  }

  /**
   * Adds a file to the ignore list. Files in the ignore list will not have any
   * changes tracked.
   *
   * @param {TFile} file - The file to add to the ignore list
   */
  public add(file: TFile): void {
    if (!file) {
      return;
    }

    this.ignoreList.add(file);
  }

  /**
   * Removes a file from the ignore list. The file becomes eligible for change
   * tracking again.
   *
   * @param {TFile} file - The file to remove from the ignore list
   */
  public remove(file: TFile): void {
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
  public isIgnored(file: TFile): boolean {
    if (!file) {
      return false;
    }

    return this.ignoreList.has(file);
  }

  /**
   * Clears all files from the ignore list. All files become eligible for change
   * tracking again.
   */
  public clear(): void {
    this.ignoreList.clear();
  }

  /**
   * Gets all files currently in the ignore list.
   *
   * @return {TFile[]} An array of files in the ignore list
   */
  public list(): TFile[] {
    return [...this.ignoreList];
  }

  /**
   * Checks whether a file path matches the configured exclude pattern. Excluded
   * paths (for example a templates or daily-notes folder) are never tracked, on
   * top of the extension filter. The pattern is a single case-insensitive regexp
   * matched against the vault-relative path; an empty pattern excludes nothing.
   * An invalid pattern excludes nothing and warns the user once so a typo cannot
   * silently disable all tracking.
   *
   * @param {TFile} file - The file to check
   * @return {boolean} True if the file path is excluded from tracking
   */
  public isExcluded(file: TFile): boolean {
    if (!file) {
      return false;
    }

    const pattern: string = this.host.getExcludePattern();

    this.warnOnInvalidExcludePattern(pattern);

    return PathExcludeHelper.isExcluded(file.path, pattern);
  }

  /**
   * Routes a one-time warning to the host when the exclude pattern does not
   * compile, so the user learns their regexp is ignored without being spammed
   * once per file. Resets the guard when the pattern becomes valid again, so a
   * later mistake is surfaced afresh.
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

    this.host.notifyInvalidPattern();
  }
}
