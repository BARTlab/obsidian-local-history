import { NO_NEWLINE_MARKER } from '@/consts';
import type {
  GutterHoverPanelResolution,
  GutterHoverPanelSegment,
} from '@/components/gutter-hover-panel.types';
import { GutterHoverPanelContentKind } from '@/components/gutter-hover-panel.types';
import * as HunkHelper from '@/helpers/hunk.helper';
import * as WordDiffHelper from '@/helpers/word-diff.helper';
import type { InlineDiffLine } from '@/types';
import type * as Diff from 'diff';

/**
 * Resolves a hovered gutter line to the {@link GutterHoverPanel} display model
 * plus the block its actions operate on. Pure (only the line-diff helpers, no
 * Obsidian or CodeMirror), so both the gutter host and the tests call it
 * directly; the controller renders the result through its host port.
 *
 * The line is resolved against the same diff the gutter reverts use: a covering
 * hunk (a change or an addition that occupies the line) via
 * {@link HunkHelper.hunkAtLine}, else the pure-deletion hunk a removed dash sits
 * on, matched exactly as the removed-gutter revert matches it (the insertion
 * point is `line + 1`, or one past the end when the deletion touched the file's
 * last line). The state is read off the block shape: no base side is an
 * addition, no current side is a removal, both is a change. Every line is
 * rendered as word segments through {@link WordDiffHelper}, the same path the
 * history modal's inline diff uses, so a change shows old-vs-new spans, an
 * addition shows the new content, and a removal shows the deleted text.
 *
 * @param {string[]} baseLines - The original (base) content as lines
 * @param {string[]} currentLines - The current content as lines
 * @param {string} lineBreak - The snapshot's line break
 * @param {number} line - The 0-based hovered line
 * @return {GutterHoverPanelResolution | null} The resolution, or null when the
 *   line maps to no change block
 */
export function resolveHoverPanelContent(
  baseLines: string[],
  currentLines: string[],
  lineBreak: string,
  line: number,
): GutterHoverPanelResolution | null {
  const hunks: Diff.StructuredPatchHunk[] = HunkHelper.diff(baseLines, currentLines, lineBreak);
  const hunk: Diff.StructuredPatchHunk | null =
    HunkHelper.hunkAtLine(hunks, line) ?? deletionHunkAt(hunks, line, currentLines.length);

  if (!hunk) {
    return null;
  }

  const baseBlock: string[] = HunkHelper.baseLinesForHunk(hunk);
  const currentBlock: string[] = currentLinesForHunk(hunk);
  const kind: GutterHoverPanelContentKind = baseBlock.length === 0
    ? GutterHoverPanelContentKind.added
    : currentBlock.length === 0
      ? GutterHoverPanelContentKind.removed
      : GutterHoverPanelContentKind.changed;

  const lines: GutterHoverPanelSegment[][] = WordDiffHelper
    .lines(baseBlock.join(lineBreak), currentBlock.join(lineBreak))
    .map((row: InlineDiffLine): GutterHoverPanelSegment[] =>
      WordDiffHelper.segments(row.oldText ?? '', row.newText ?? '').map(toSegment),
    );

  return { content: { kind, lines }, hunk, baseText: baseBlock.join(lineBreak) };
}

/**
 * Finds the pure-deletion hunk a removed dash on the given line sits on, matched
 * the same way the removed-gutter revert matches it: the 1-based reinsertion
 * point is `line + 1`, except a deletion that touched the file's last line
 * clamps its anchor onto the last current line and reinserts one past the end
 * (`length + 1`), accepted only when the marker is on the last line.
 *
 * @param {Diff.StructuredPatchHunk[]} hunks - The hunks of the current diff
 * @param {number} line - The 0-based line the removed dash sits on
 * @param {number} currentLength - The current line count
 * @return {Diff.StructuredPatchHunk | null} The deletion hunk, or null
 */
function deletionHunkAt(
  hunks: Diff.StructuredPatchHunk[],
  line: number,
  currentLength: number,
): Diff.StructuredPatchHunk | null {
  const insertionPoint: number = line + 1;
  const eofInsertionPoint: number = currentLength + 1;
  const isLastLine: boolean = line === currentLength - 1;

  return hunks.find((hunk: Diff.StructuredPatchHunk): boolean =>
    hunk.newLines === 0 && (hunk.newStart === insertionPoint || (isLastLine && hunk.newStart === eofInsertionPoint)),
  ) ?? null;
}

/**
 * Extracts the current-side lines of a hunk (context and added lines), the
 * mirror of {@link HunkHelper.baseLinesForHunk}, so the word diff can compare
 * the block's base side against its current side.
 *
 * @param {Diff.StructuredPatchHunk} hunk - The hunk to read
 * @return {string[]} The current-side line contents
 */
function currentLinesForHunk(hunk: Diff.StructuredPatchHunk): string[] {
  return (hunk?.lines ?? [])
    .filter((line: string): boolean => line !== NO_NEWLINE_MARKER && (line[0] === ' ' || line[0] === '+'))
    .map((line: string): string => line.slice(1));
}

/**
 * Maps a diff-library word change to the port's segment shape.
 *
 * @param {Diff.Change} change - The word-level change
 * @return {GutterHoverPanelSegment} The segment
 */
function toSegment(change: Diff.Change): GutterHoverPanelSegment {
  return { text: change.value, added: change.added === true, removed: change.removed === true };
}
