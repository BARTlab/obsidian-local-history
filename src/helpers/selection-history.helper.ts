import { HunkHelper, type HunkLineKind } from '@/helpers/hunk.helper';
import type { SelectableVersion } from '@/types';
import * as Diff from 'diff';

/**
 * Pure helper backing the "Show History for Selection" filter. Given a
 * selection text and the timeline versions plus the history baseline, it
 * returns the ids of the versions whose diff against the previous point on
 * the timeline added or removed a line containing the selection text.
 *
 * This is the precise changed/added/removed detection chosen over the
 * cheap "content contains the selection" filter: a version is included only
 * when the selection actually appeared or disappeared at that point, not when
 * it merely coexists with the surrounding text.
 *
 * The helper has no Obsidian/DOM dependency: it takes plain line arrays plus
 * a selection string and returns a Set of ids. An empty or whitespace-only
 * selection matches no versions (the caller is expected to fall back to the
 * unfiltered modal in that case).
 */
export class SelectionHistoryHelper {
  /**
   * Resolves the ids of the versions where the selection text was added or
   * removed at that point on the timeline.
   *
   * Each version is diffed against its previous neighbour in the supplied
   * order (the oldest entry is diffed against `baselineLines`). A version is
   * included when any line added or removed by that neighbour-diff contains
   * the selection text. For a multi-line selection, every non-empty selection
   * line must appear in the added or removed lines of the same side, so the
   * filter matches genuine block edits rather than coincidental single-line
   * overlaps.
   *
   * The match is case-sensitive and substring-based on the changed lines,
   * mirroring how a user reads the diff.
   *
   * @param {SelectableVersion[]} versions - The timeline versions in oldest-first order
   * @param {string[]} baselineLines - The history baseline lines, used as the previous neighbour for the oldest version
   * @param {string} selection - The selection text to look for in added/removed lines
   * @return {Set<string>} The ids of the matching versions; empty when the selection is empty
   */
  public static match(versions: SelectableVersion[], baselineLines: string[], selection: string): Set<string> {
    const matched: Set<string> = new Set();
    const list: SelectableVersion[] = versions ?? [];
    const needle: string = (selection ?? '').trim();

    if (needle === '' || list.length === 0) {
      return matched;
    }

    const selectionLines: string[] = SelectionHistoryHelper.toSelectionLines(needle);

    if (selectionLines.length === 0) {
      return matched;
    }

    let previous: string[] = baselineLines ?? [];

    for (const version of list) {
      const current: string[] = version?.lines ?? [];
      const { added, removed } = SelectionHistoryHelper.collectChangedLines(previous, current);

      if (
        SelectionHistoryHelper.allLinesPresent(selectionLines, added)
        || SelectionHistoryHelper.allLinesPresent(selectionLines, removed)
      ) {
        matched.add(version.id);
      }

      previous = current;
    }

    return matched;
  }

  /**
   * Splits the selection into non-empty trimmed lines. Empty lines inside the
   * selection are dropped so a block selection ending on a blank line still
   * matches when only the content lines appear in the diff. When the entire
   * selection is whitespace the returned list is empty and the caller treats
   * the selection as a no-op.
   *
   * @param {string} selection - The trimmed selection text
   * @return {string[]} The selection split into non-empty lines
   */
  private static toSelectionLines(selection: string): string[] {
    return selection
      .split(/\r?\n/)
      .map((line: string): string => line.trim())
      .filter((line: string): boolean => line.length > 0);
  }

  /**
   * Collects the added and removed lines between two contents using a
   * structured patch with zero context, so each hunk's lines are exactly the
   * changed lines on either side. A trailing newline is appended to both texts
   * before diffing for the same reason as in VersionLabelHelper: without it the
   * last "no-newline" run gets merged into a coarser block and inflates the
   * counts.
   *
   * @param {string[]} previous - The previous content as lines
   * @param {string[]} current - The current content as lines
   * @return {{ added: string[]; removed: string[] }} The plain content of added/removed lines
   */
  private static collectChangedLines(previous: string[], current: string[]): { added: string[]; removed: string[] } {
    const added: string[] = [];
    const removed: string[] = [];

    if (previous.length === 0 && current.length === 0) {
      return { added, removed };
    }

    /**
     * Strip a trailing `\r` from each line before joining with LF:
     * a CRLF-origin version array carries `\r` at the tail of every line, which
     * would otherwise survive into the structured-patch hunk and miss the
     * selection match by a single byte.
     */
    const normalize = (lines: string[]): string[] => lines.map(
      (line: string): string => (line.endsWith('\r') ? line.slice(0, -1) : line),
    );

    const previousText: string = `${normalize(previous).join('\n')}\n`;
    const currentText: string = `${normalize(current).join('\n')}\n`;

    if (previousText === currentText) {
      return { added, removed };
    }

    const hunks: Diff.StructuredPatchHunk[] = Diff
      .structuredPatch('', '', previousText, currentText, '', '', { context: 0 })
      .hunks;

    for (const hunk of hunks) {
      for (const line of hunk.lines) {
        const kind: HunkLineKind = HunkHelper.classifyLine(line);

        if (kind === 'added') {
          added.push(line.slice(1));
        }

        if (kind === 'removed') {
          removed.push(line.slice(1));
        }
      }
    }

    return { added, removed };
  }

  /**
   * Whether every selection line appears as a substring of at least one of the
   * supplied changed lines. Used to keep multi-line selections from matching
   * versions where only a single fragment overlaps; for single-line selections
   * the check reduces to "at least one changed line contains the selection".
   *
   * @param {string[]} selectionLines - The non-empty selection lines to look for
   * @param {string[]} changedLines - The added or removed lines from a single side
   * @return {boolean} True when every selection line is found in at least one changed line
   */
  private static allLinesPresent(selectionLines: string[], changedLines: string[]): boolean {
    if (changedLines.length === 0) {
      return false;
    }

    return selectionLines.every((selectionLine: string): boolean => changedLines.some(
      (changedLine: string): boolean => changedLine.includes(selectionLine),
    ));
  }
}
