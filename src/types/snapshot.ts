import type { VersionAction, WordDiffLineType } from '@/consts';
import type { FileVersion } from '@/snapshots/file.version';

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
 * The normalized result of adopting a persisted history baseline and version
 * timeline. The collaborator produces defensive copies and the façade assigns
 * each field back; `versions` belongs to the timeline cluster but adoptHistory
 * sets it alongside the history baseline, so it is carried back here too.
 */
export interface AdoptHistoryResult {
  /** The defensive copy of the persisted history baseline lines. */
  historyLines: string[];

  /** The defensive copy of the persisted version timeline, oldest first. */
  versions: FileVersion[];
}

/**
 * The outcome of an updateState call: the normalized current state lines and the
 * hash of that state. The façade owns both `state` and `lastHash`, so the
 * collaborator returns both for the façade to write back.
 */
export interface UpdateStateResult {
  /** The defensive copy of the current state as an array of lines. */
  state: string[];

  /** The hash of the current state, used for change detection. */
  lastHash: string;
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
 * The façade-owned inputs a capture attempt operates on. Bundles the timeline
 * array, the empty-timeline dedup reference (the history baseline), the line
 * break, and the cadence/retention options so the collaborator stays a stateless
 * operator over passed-in state without a long positional parameter list.
 */
export interface VersionCaptureContext {
  /** The current timeline, oldest first. The façade owns this array. */
  versions: FileVersion[];

  /** The history baseline used as the dedup reference when the timeline is empty. */
  historyBaseline: string;

  /** The line break used to join candidate content for comparison. */
  lineBreak: string;

  /** The capture cadence configuration and retention caps. */
  options: SnapshotCaptureOptions;
}

/**
 * Outcome of a capture attempt. `version` is the freshly pushed version (or null
 * when the cadence/dedup gates skipped it), and `versions` is the timeline array
 * the façade must adopt: unchanged on a skip, or the appended-then-evicted array
 * on a capture. The façade owns the `versions` field, so the collaborator hands
 * the resulting array back rather than mutating a private copy.
 */
export interface VersionCaptureResult {
  /** The version pushed onto the timeline, or null when no version was taken. */
  version: FileVersion | null;

  /** The timeline array the façade must store after the attempt. */
  versions: FileVersion[];
}
