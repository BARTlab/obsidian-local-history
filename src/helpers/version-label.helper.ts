import * as Diff from 'diff';
import { VersionAction } from '@/consts';

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
 * Pure helper that derives a human action description for a version from its
 * content compared to the previous point on the timeline.
 *
 * The description is computed at render time rather than persisted on the
 * version (D1): the action is fully derivable from content the snapshot already
 * stores, so it cannot rot when neighbours move. The helper has no Obsidian or
 * DOM dependency and is unit-testable directly.
 *
 * Rules:
 * - Previous empty, current non-empty -> created.
 * - Previous non-empty, current empty -> cleared.
 * - Otherwise (both non-empty and they differ, or both empty) -> modified.
 *
 * "Empty" means no lines at all OR every line is the empty string. That keeps
 * a [""] singleton (which a freshly opened file often carries) on the same
 * footing as an actual empty content array.
 *
 * The added/removed counts come from a line-level diff between previous and
 * current contents and reflect only changed lines (context lines do not count).
 */
export class VersionLabelHelper {
  /**
   * Describes the transition from previous to current as an action plus the
   * line-level delta. Symmetric in shape: both empty inputs are handled, and
   * the result is well-defined even when the two contents are identical (kind
   * is "modified" with zero added and zero removed, which the UI can render or
   * suppress as it sees fit).
   *
   * @param {string[]} previousLines - The previous content as an array of lines
   * @param {string[]} currentLines - The current content as an array of lines
   * @return {VersionDescription} The action kind plus the added/removed counts
   */
  public static describe(previousLines: string[], currentLines: string[]): VersionDescription {
    const previous: string[] = previousLines ?? [];
    const current: string[] = currentLines ?? [];

    const previousEmpty: boolean = VersionLabelHelper.isEmpty(previous);
    const currentEmpty: boolean = VersionLabelHelper.isEmpty(current);

    const { added, removed }: { added: number; removed: number } = VersionLabelHelper.countDelta(previous, current);

    if (previousEmpty && !currentEmpty) {
      return { kind: VersionAction.created, added, removed };
    }

    if (!previousEmpty && currentEmpty) {
      return { kind: VersionAction.cleared, added, removed };
    }

    return { kind: VersionAction.modified, added, removed };
  }

  /**
   * Whether a line array represents empty content (no lines, or only empty
   * lines). Treating a single empty-string line as empty matches how a brand
   * new file is captured.
   *
   * @param {string[]} lines - The lines to inspect
   * @return {boolean} True when there is no meaningful content
   */
  private static isEmpty(lines: string[]): boolean {
    if (lines.length === 0) {
      return true;
    }

    return lines.every((line: string): boolean => line === '');
  }

  /**
   * Counts added and removed lines between two contents using a structured
   * patch with zero context, so each hunk's lines are exactly the changed
   * lines on either side. A trailing newline is appended to both texts before
   * diffing: without it the diff library merges the last "no-newline" run into
   * a coarser block (e.g. a single-line edit can leak into the following
   * unchanged line), inflating both counts. The newline is then ignored as a
   * meta marker, leaving only true `+`/`-` lines counted.
   *
   * @param {string[]} previous - The previous content as lines
   * @param {string[]} current - The current content as lines
   * @return {{ added: number; removed: number }} The line delta
   */
  private static countDelta(previous: string[], current: string[]): { added: number; removed: number } {
    const previousEmpty: boolean = VersionLabelHelper.isEmpty(previous);
    const currentEmpty: boolean = VersionLabelHelper.isEmpty(current);

    // For empty-side transitions count the non-empty side directly: a
    // structured patch against an empty array yields a phantom "-" line for
    // the trailing newline marker, which would over-count by one.
    if (previousEmpty && currentEmpty) {
      return { added: 0, removed: 0 };
    }

    if (previousEmpty) {
      return { added: current.filter((line: string): boolean => line !== '').length, removed: 0 };
    }

    if (currentEmpty) {
      return { added: 0, removed: previous.filter((line: string): boolean => line !== '').length };
    }

    const previousText: string = `${previous.join('\n')}\n`;
    const currentText: string = `${current.join('\n')}\n`;

    if (previousText === currentText) {
      return { added: 0, removed: 0 };
    }

    const hunks: Diff.StructuredPatchHunk[] = Diff
      .structuredPatch('', '', previousText, currentText, '', '', { context: 0 })
      .hunks;

    let added: number = 0;
    let removed: number = 0;

    for (const hunk of hunks) {
      for (const line of hunk.lines) {
        if (line.startsWith('+')) {
          added += 1;
        } else if (line.startsWith('-')) {
          removed += 1;
        }
      }
    }

    return { added, removed };
  }
}
