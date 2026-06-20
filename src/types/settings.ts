import type { IndicatorType, KeepHistory } from '@/consts';

/**
 * Configuration interface for the Line Change Tracker plugin settings.
 * Defines all customizable options for tracking and displaying line changes.
 */
export interface LineChangeTrackerSettings {
  /**
   * Configuration for which types of changes to show
   */
  show: {
    /**
     * Whether to show changed lines
     */
    changed: boolean;
    /**
     * Whether to show restored lines
     */
    restored: boolean;
    /**
     * Whether to show added lines
     */
    added: boolean;
    /**
     * Whether to show removed lines
     */
    removed: boolean;
  };

  /**
   * Configuration for line appearance
   */
  line: {
    /**
     * Width of the change indicator line in pixels
     */
    width: number;
  };

  /**
   * Configuration for gutter colors
   */
  gutter: {
    /**
     * Color for restored lines
     */
    restored: string;
    /**
     * Color for changed lines
     */
    changed: string;
    /**
     * Color for added lines
     */
    added: string;
    /**
     * Color for removed lines
     */
    removed: string;
  };

  /**
   * Configuration for on-disk history retention caps
   */
  retention: {
    /**
     * Maximum number of file histories kept on disk (size cap, 0 disables)
     */
    maxEntries: number;
    /**
     * Maximum age in days for a persisted history (age cap, 0 disables)
     */
    maxAgeDays: number;
    /**
     * Maximum number of tombstone (deleted-file) histories kept on disk (size cap, 0 disables)
     */
    maxDeletedEntries: number;
    /**
     * Maximum age in days for a persisted tombstone history (age cap, 0 disables)
     */
    maxDeletedAgeDays: number;
  };

  /**
   * Configuration for periodic intermediate snapshots (the timeline)
   */
  snapshots: {
    /**
     * Whether to capture intermediate versions while editing
     */
    enabled: boolean;
    /**
     * Minimum time (ms) between captured versions (0 disables the time gate)
     */
    intervalMs: number;
    /**
     * Minimum number of edits between captured versions (0 disables it)
     */
    editThreshold: number;
    /**
     * Maximum number of intermediate versions kept per file (count cap, oldest evicted, 0 disables)
     */
    maxVersions: number;
    /**
     * Maximum age in days for an intermediate version (age cap, oldest evicted, 0 disables)
     */
    maxVersionAgeDays: number;
  };

  /**
   * Type of indicator to use for showing changes
   */
  type: IndicatorType;
  /**
   * History retention policy
   */
  keep: KeepHistory;
  /**
   * Persist history to disk so it survives an app restart
   */
  persist: boolean;
  /**
   * File extensions that are allowed for tracking (comma-separated)
   */
  allowedExtensions: string;
  /**
   * Path/glob patterns to exclude from tracking (comma- or newline-separated)
   */
  excludePaths: string;
  /**
   * Whether the excludePaths regular expression is matched case-sensitively.
   * When true, the 'i' flag is NOT applied; when false (default), the pattern
   * is case-insensitive to behave well on case-insensitive file systems.
   */
  excludePathsCaseSensitive: boolean;
  /**
   * Whether to ignore newly created files
   */
  ignoreNewFiles: boolean;
  /**
   * Whether to tint native file-explorer rows and workspace tab headers by
   * their session change status (the tree + tab highlight feature)
   */
  treeHighlight: boolean;
  /**
   * Whether to highlight added, modified, and removed properties in the
   * Obsidian Properties panel (the properties-diff feature)
   */
  propertiesHighlight: boolean;
}
