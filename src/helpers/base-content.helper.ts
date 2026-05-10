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
 * Pure helper backing the history modal's diff-base resolution (D1). Given the
 * selected base id and a reduced snapshot view, it returns the content the
 * current state should be diffed against.
 *
 * The synthetic baseline entry diffs the current document against the LATEST
 * snapshot (`getVersions()[0]`, the timeline is newest first), falling back to
 * the original only when no snapshot exists, so the "what changed" view is
 * anchored to the last saved version rather than the file's birth state. A
 * picked intermediate version resolves to that version's content; an id that no
 * longer addresses a version falls through to the same baseline rule.
 */
export class BaseContentHelper {
  /**
   * Resolves the base content to diff the current state against.
   *
   * @param {string} selectedBaseId - The picked base id (the synthetic baseline
   *   sentinel or an intermediate version id)
   * @param {string} baselineId - The sentinel id that marks the synthetic
   *   baseline entry
   * @param {BaseContentSnapshot} snapshot - The reduced snapshot view to read
   * @return {string} The base content for the diff
   */
  public static resolve(selectedBaseId: string, baselineId: string, snapshot: BaseContentSnapshot): string {
    if (selectedBaseId !== baselineId) {
      const content: string | null = snapshot.versionContent(selectedBaseId);

      if (content !== null) {
        return content;
      }
    }

    // Synthetic baseline (or a stale id): diff against the latest snapshot,
    // falling back to the original only when the timeline is empty.
    const latest: string | undefined = snapshot.versions[0];

    return latest ?? snapshot.original;
  }
}
