import { PathExcludeHelper } from '@/helpers/path-exclude.helper';
import type { IgnoreListHost } from '@/snapshots/ignore-list.types';
import type { TFile } from 'obsidian';

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
   * The last exclude-pattern list a user was warned about for containing an
   * invalid entry, joined into a single key. Keeps the "invalid regexp" warning
   * from firing on every captured file: the warning shows once per distinct bad
   * list until the user edits it to an all-valid one (or to a different bad one).
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
   * Checks whether a file path matches any configured exclude pattern. Excluded
   * paths (for example a templates or daily-notes folder) are never tracked, on
   * top of the extension filter. Each pattern is a regexp matched against the
   * vault-relative path and the entries are OR'd; case sensitivity is controlled
   * by the host setting. An empty list excludes nothing. An invalid entry
   * excludes nothing for that entry and warns the user once so a typo cannot
   * silently disable all tracking.
   *
   * @param {TFile} file - The file to check
   * @return {boolean} True if the file path is excluded from tracking
   */
  public isExcluded(file: TFile): boolean {
    if (!file) {
      return false;
    }

    const patterns: string[] = this.host.getExcludePatterns();
    const caseSensitive: boolean = this.host.getExcludePathsCaseSensitive();

    this.warnOnInvalidExcludePattern(patterns);

    return PathExcludeHelper.isExcluded(file.path, patterns, caseSensitive);
  }

  /**
   * Routes a one-time warning to the host when any exclude entry does not
   * compile, so the user learns their regexp is ignored without being spammed
   * once per file. The warn-once guard is keyed on the joined list, so editing
   * the list to an all-valid state resets the guard and a later mistake is
   * surfaced afresh.
   *
   * @param {string[]} patterns - The raw exclude patterns from settings
   */
  protected warnOnInvalidExcludePattern(patterns: string[]): void {
    if (patterns.every((pattern: string): boolean => PathExcludeHelper.isValid(pattern))) {
      this.lastWarnedExcludePattern = null;

      return;
    }

    const key: string = patterns.join('\n');

    if (this.lastWarnedExcludePattern === key) {
      return;
    }

    this.lastWarnedExcludePattern = key;

    this.host.notifyInvalidPattern();
  }
}
