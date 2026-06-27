import { NO_NEWLINE_MARKER } from '@/consts';
import type { EditorBlock } from '@/snapshots/editor-operations';
import * as Diff from 'diff';

/**
 * Classification of a single structured-patch line by its diff prefix.
 */
export type HunkLineKind = 'added' | 'removed' | 'context';

/**
 * Helper for line-level diff hunks and single-hunk reverts.
 *
 * A "hunk" is one contiguous block of changes between a base text and the
 * current text, as produced by the diff library. Reverting a single hunk means
 * writing only that block back to the base, leaving every other change in the
 * current text intact. All methods are pure and operate on arrays of lines, so
 * they are independent of the editor and the Obsidian runtime and can be unit
 * tested directly.
 */
export class HunkHelper {
  /**
   * Computes the line-level hunks between a base text and the current text.
   * Uses zero context so each hunk covers only the changed lines, which keeps
   * a per-hunk revert scoped to exactly that block.
   *
   * @param {string[]} baseLines - The base content as an array of lines
   * @param {string[]} currentLines - The current content as an array of lines
   * @param {string} lineBreak - The line break used to join lines for diffing
   * @return {Diff.StructuredPatchHunk[]} The hunks, ordered from top to bottom
   */
  public static diff(
    baseLines: string[],
    currentLines: string[],
    lineBreak: string = '\n',
  ): Diff.StructuredPatchHunk[] {
    const base: string = (baseLines ?? []).join(lineBreak);
    const current: string = (currentLines ?? []).join(lineBreak);

    if (base === current) {
      return [];
    }

    return Diff.structuredPatch('', '', base, current, '', '', { context: 0 }).hunks;
  }

  /**
   * Extracts the base-side lines of a hunk (the context and removed lines),
   * with their diff prefixes stripped and the no-newline marker dropped. These
   * are exactly the lines that must replace the hunk's region in the current
   * text to revert it.
   *
   * @param {Diff.StructuredPatchHunk} hunk - The hunk to read
   * @return {string[]} The base-side line contents of the hunk
   */
  public static baseLinesForHunk(hunk: Diff.StructuredPatchHunk): string[] {
    return (hunk?.lines ?? [])
      .filter((line: string): boolean => line !== NO_NEWLINE_MARKER && (line[0] === ' ' || line[0] === '-'))
      .map((line: string): string => line.slice(1));
  }

  /**
   * Finds the hunk whose current-side region contains the given line, so a
   * revert affordance placed on that line maps back to exactly one changed
   * block. Only hunks that occupy at least one current line are considered (a
   * pure deletion occupies none, so it has no line to click on the gutter and is
   * skipped here). The region is the 0-based half-open interval
   * [newStart - 1, newStart - 1 + newLines).
   *
   * @param {Diff.StructuredPatchHunk[]} hunks - The hunks to search, top to bottom
   * @param {number} line - The 0-based current line to resolve
   * @return {Diff.StructuredPatchHunk | null} The covering hunk, or null if none
   */
  public static hunkAtLine(hunks: Diff.StructuredPatchHunk[], line: number): Diff.StructuredPatchHunk | null {
    if (!Array.isArray(hunks)) {
      return null;
    }

    return hunks.find((hunk: Diff.StructuredPatchHunk): boolean => {
      if (!hunk || hunk.newLines <= 0) {
        return false;
      }

      const start: number = hunk.newStart - 1;

      return line >= start && line < start + hunk.newLines;
    }) ?? null;
  }

  /**
   * Reverts a single hunk against the current lines and returns the resulting
   * lines. Only the region this hunk occupies in the current text is replaced
   * by the hunk's base-side lines; every line outside the region is preserved
   * verbatim.
   *
   * The replacement is positional against the live current text (via newStart
   * and newLines), not against stale indices, so the offsets of all other hunks
   * stay correct: reverting hunk N never disturbs hunk N+1, because the slice
   * lengths of a single block edit cancel out for the untouched lines around it.
   *
   * @param {string[]} currentLines - The current content as an array of lines
   * @param {Diff.StructuredPatchHunk} hunk - The hunk to revert
   * @return {string[]} A new array of lines with only this hunk reverted
   */
  public static revertHunk(currentLines: string[], hunk: Diff.StructuredPatchHunk): string[] {
    const lines: string[] = [...(currentLines ?? [])];

    if (!hunk) {
      return lines;
    }

    /**
     * newStart is 1-based; clamp into range so a hunk at the very end (where
     * newStart can point one past the last line) still splices safely.
     */
    const start: number = Math.max(0, Math.min(lines.length, hunk.newStart - 1));

    lines.splice(start, Math.max(0, hunk.newLines), ...HunkHelper.baseLinesForHunk(hunk));

    return lines;
  }

  /**
   * Builds the {@link EditorBlock} descriptor for reverting a hunk: the clamped
   * start (the same clamp {@link revertHunk} applies), the current-side span to
   * replace, and the base-side lines to write. Shared by every revert call site
   * so the block handed to the snapshot service is computed in one place.
   *
   * @param {string[]} currentLines - The current content as an array of lines
   * @param {Diff.StructuredPatchHunk} hunk - The hunk to revert
   * @return {EditorBlock} The block descriptor for the snapshot apply
   */
  public static revertDescriptor(currentLines: string[], hunk: Diff.StructuredPatchHunk): EditorBlock {
    const start: number = Math.max(0, Math.min((currentLines ?? []).length, hunk.newStart - 1));

    return {
      start,
      removeCount: hunk.newLines,
      newLines: HunkHelper.baseLinesForHunk(hunk),
    };
  }

  /**
   * Classifies a structured-patch line by its diff prefix. The meta no-newline
   * marker and context lines both read as `context`, so callers count or collect
   * only genuine additions and removals.
   *
   * @param {string} line - The raw hunk line, including its diff prefix
   * @return {HunkLineKind} Whether the line was added, removed, or is context
   */
  public static classifyLine(line: string): HunkLineKind {
    if (line.startsWith('+')) {
      return 'added';
    }

    if (line.startsWith('-')) {
      return 'removed';
    }

    return 'context';
  }
}
