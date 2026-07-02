import type { VersionAction, WordDiffLineType } from '@/consts';

/**
 * Options that govern when an intermediate version is captured on the timeline.
 * Mirrors the user-facing `snapshots` settings and is passed to
 * FileSnapshot.captureVersion so the model stays decoupled from the settings
 * service.
 */
export interface SnapshotCaptureOptions {
  /** Whether intermediate version capture is enabled at all */
  enabled: boolean;
  /** Minimum time (ms) between captures (0 disables the time gate) */
  intervalMs: number;
  /** Minimum number of edits between captures (0 disables the edit gate) */
  editThreshold: number;
  /** Maximum number of versions kept (count cap, oldest evicted past this, 0 disables) */
  maxVersions: number;
  /** Maximum age in days for a kept version (age cap, evicted first, 0 disables) */
  maxVersionAgeDays: number;
}

/**
 * Interface defining the parameters for creating a TrackerLine instance.
 * Used to initialize a line tracker with optional properties.
 */
export interface TrackerLineParams {
  /** The content of the line as a string */
  content?: string;

  /** The original position (line number) in the document */
  originalPosition?: number;

  /** The current position (line number) in the document */
  currentPosition?: number;

  /** Whether the content is the same as in the original document */
  contentSameOriginal?: boolean;
}

/**
 * The slice of a snapshot the base-content resolution needs, reduced to the
 * three reads the history modal performs when picking a diff base. Keeping the
 * helper to this minimal shape (instead of a full FileSnapshot) is what lets the
 * resolution stay a pure, directly unit-tested function with no Obsidian or
 * model dependency.
 */
export interface BaseContentSnapshot {
  /**
   * The captured content of the timeline versions, newest first (mirrors
   * `FileSnapshot.getVersions()` mapped through `getContent`). The first entry,
   * when present, is the latest snapshot the baseline entry diffs against.
   */
  versions: string[];
  /** The file's original captured content (the birth-state fallback). */
  original: string;
  /**
   * Resolves a picked intermediate version's content by id, or null when the id
   * does not address an existing version (mirrors `FileSnapshot.getVersion`).
   *
   * @param {string} id - The version id to resolve
   * @return {string | null} The version content, or null when absent
   */
  versionContent(id: string): string | null;
}

/**
 * One line of an inline diff. A line is either unchanged context, a pure
 * addition, a pure removal, or a modification (a removed and added pair that
 * represent the same logical line). For a modified line both the old and the
 * new text are kept so the renderer can show word-level spans for each side.
 */
export interface InlineDiffLine {
  /** The kind of change this line represents. */
  type: WordDiffLineType;
  /** The old (base) text of the line, present for context, removed, modified. */
  oldText?: string;
  /** The new (current) text of the line, present for context, added, modified. */
  newText?: string;
}

/**
 * One timeline version reduced to just what the selection filter needs: its
 * stable id and its captured lines. Kept intentionally minimal (instead of
 * `FileVersion`) so the helper stays pure and directly unit-testable with no
 * Obsidian or model dependency.
 *
 * Versions are passed in the order the rail renders them; the helper itself is
 * order-agnostic and uses the explicit `baselineLines` parameter rather than an
 * out-of-band convention to anchor the oldest version's diff.
 */
export interface SelectableVersion {
  /** The version's stable id, returned when its diff touches the selection. */
  id: string;
  /** The version's captured content as lines, diffed against its neighbour. */
  lines: string[];
}

/**
 * One searchable timeline version reduced to just what the rail filter needs:
 * its stable id and its captured text. Keeping the helper to this minimal shape
 * (instead of a full FileVersion) is what lets the filter stay a pure, directly
 * unit-tested function with no Obsidian or model dependency.
 */
export interface SearchableVersion {
  /** The version's stable id, returned when its content matches. */
  id: string;
  /** The version's captured content, searched case-insensitively. */
  content: string;
}

/**
 * The pure result of describing a version. Carries the discriminator plus the
 * line-level delta of the transition (number of newly added lines and number of
 * removed lines), so the UI can render "Modified (+3, -1)" inline without
 * running the diff twice.
 */
export interface VersionDescription {
  /** The action discriminator for the version. */
  kind: VersionAction;
  /** Number of lines added going from previous to current. */
  added: number;
  /** Number of lines removed going from previous to current. */
  removed: number;
}

/**
 * Result of restoring a selected version. The flag tells the caller whether the
 * write happened, so a UI can refresh its diff/rail only when something actually
 * changed (a no-op restore against identical content stays silent).
 */
export interface VersionRestoreResult {
  /** True when the file content was rewritten to the version. */
  applied: boolean;
}

/**
 * Result of removing a selected version, including the next selection id the
 * caller can fall back to so a UI list stays focused on a sensible neighbour
 * after the deletion. The id is null when the timeline is now empty.
 */
export interface VersionRemoveResult {
  /** True when a version was dropped from the timeline. */
  removed: boolean;
  /** The id the caller should select next, or null when nothing remains. */
  nextId: string | null;
}

/**
 * The inputs a capture attempt reads besides the owned timeline. Bundles the
 * empty-timeline dedup reference (the history baseline), the line break, and the
 * cadence/retention options so VersionTimeline.capture reads them without a long
 * positional parameter list. The versions array is not passed: the timeline owns
 * it.
 */
export interface VersionCaptureContext {
  /** The history baseline used as the dedup reference when the timeline is empty. */
  historyBaseline: string;

  /** The line break used to join candidate content for comparison. */
  lineBreak: string;

  /** The capture cadence configuration and retention caps. */
  options: SnapshotCaptureOptions;
}

/**
 * A single block change expressed in tracker terms: the contiguous run of
 * current lines a revert/apply replaces and the content it should hold
 * afterwards. Mirrors the hunk shape the history modal and version-actions
 * service scope before writing it back through {@link EditorOperations}.
 */
export interface EditorBlock {
  /** The 0-based current line where the block begins. */
  start: number;

  /** How many current lines the block spans. */
  removeCount: number;

  /** The content the block should hold afterwards. */
  newLines: string[];
}
