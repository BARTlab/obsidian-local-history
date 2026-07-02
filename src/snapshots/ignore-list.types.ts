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
   * The raw, user-configured exclude patterns from settings. Each entry is a
   * regexp matched against the vault-relative path; the entries are OR'd and an
   * empty list excludes nothing.
   *
   * @return {string[]} The current exclude patterns
   */
  getExcludePatterns(): string[];

  /**
   * Whether the exclude pattern is matched case-sensitively. When true the 'i'
   * flag is NOT applied. Defaults to false (case-insensitive) to behave well on
   * case-insensitive file systems.
   *
   * @return {boolean} True when matching is case-sensitive
   */
  getExcludePathsCaseSensitive(): boolean;

  /**
   * Shows the user a one-time toast that their exclude pattern is malformed and
   * therefore ignored. Routed through the host so the manager does not depend on
   * the plugin's i18n or the Obsidian Notice; the warn-once gating lives in the
   * manager so the host is called at most once per distinct bad pattern.
   */
  notifyInvalidPattern(): void;
}
