import type {
  GutterHoverLineInput,
  GutterHoverPanelResolution,
  GutterHoverPanelSegment,
} from '@/components/gutter-hover-panel.types';
import { GutterHoverPanelContentKind } from '@/components/gutter-hover-panel.types';
import { ChangeType } from '@/consts';
import * as WordDiffHelper from '@/helpers/word-diff.helper';
import type * as Diff from 'diff';

/**
 * Resolves a hovered gutter line to the {@link GutterHoverPanel} display model
 * plus the block its actions operate on. Pure (only the word-diff helper, no
 * Obsidian or CodeMirror), so both the gutter host and the tests call it
 * directly; the controller renders the result through its host port.
 *
 * The input is tracker-sourced ({@link GutterHoverLineInput}): the host reads
 * the hovered line's change kind and per-line baseline text off the same change
 * map and tracker the gutter markers are drawn from, so the panel always shows
 * exactly the hovered line's previous version. The earlier base-vs-state line
 * diff was a second, independent model of "what changed": its LCS alignment
 * merged rewritten regions into one block (every marker in the region showed the
 * same content) and drifted off the tracker on repetitive lines (markers with an
 * empty panel).
 *
 * A changed line shows old-vs-new word spans, an added line shows the new
 * content, and a removed dash shows the deleted baseline lines. The returned
 * hunk is synthesized in structured-patch shape and scoped to exactly the shown
 * change, so the revert applies precisely what the panel displays.
 *
 * @param {GutterHoverLineInput} input - The tracker-sourced facts for the line
 * @param {string} lineBreak - The snapshot's line break, used to join copy text
 * @return {GutterHoverPanelResolution | null} The resolution, or null when the
 *   line maps to no revertable change (a restored or untracked line)
 */
export function resolveHoverPanelContent(
  input: GutterHoverLineInput,
  lineBreak: string,
): GutterHoverPanelResolution | null {
  if (input.kind === ChangeType.removed) {
    return resolveRemoved(input, lineBreak);
  }

  if (input.kind === ChangeType.added) {
    return resolveAdded(input);
  }

  if ((input.kind === ChangeType.changed || input.kind === ChangeType.whitespace) && input.original !== null) {
    return resolveChanged(input);
  }

  return null;
}

/**
 * Resolves a changed (or whitespace-only changed) line: one row of old-vs-new
 * word segments and a one-line replace hunk that writes the baseline text back
 * over the hovered line.
 *
 * @param {GutterHoverLineInput} input - The line facts; `original` is non-null here
 * @return {GutterHoverPanelResolution} The resolution
 */
function resolveChanged(input: GutterHoverLineInput): GutterHoverPanelResolution {
  const original: string = input.original as string;
  const hunk: Diff.StructuredPatchHunk = {
    oldStart: input.line + 1,
    oldLines: 1,
    newStart: input.line + 1,
    newLines: 1,
    lines: [`-${original}`, `+${input.current}`],
  };

  return {
    content: {
      kind: GutterHoverPanelContentKind.changed,
      lines: [WordDiffHelper.segments(original, input.current).map(toSegment)],
      blank: !hasVisibleText([original, input.current]),
    },
    hunk,
    baseText: original,
  };
}

/**
 * Resolves an added line: one row of added word segments and a one-line
 * deletion hunk (empty base side), so the revert removes the inserted line.
 *
 * @param {GutterHoverLineInput} input - The line facts
 * @return {GutterHoverPanelResolution} The resolution
 */
function resolveAdded(input: GutterHoverLineInput): GutterHoverPanelResolution {
  const hunk: Diff.StructuredPatchHunk = {
    oldStart: input.line + 1,
    oldLines: 0,
    newStart: input.line + 1,
    newLines: 1,
    lines: [`+${input.current}`],
  };

  return {
    content: {
      kind: GutterHoverPanelContentKind.added,
      lines: [WordDiffHelper.segments('', input.current).map(toSegment)],
      blank: !hasVisibleText([input.current]),
    },
    hunk,
    baseText: '',
  };
}

/**
 * Resolves a removed dash: one row of removed word segments per deleted
 * baseline line and a pure-deletion hunk that reinserts the block at the
 * anchor. The insertion point sits before the hovered line, or one past it when
 * the anchor was clamped onto the file's last line ({@link GutterHoverLineInput#removedAfter}).
 *
 * @param {GutterHoverLineInput} input - The line facts
 * @param {string} lineBreak - The snapshot's line break, used to join copy text
 * @return {GutterHoverPanelResolution | null} The resolution, or null when no
 *   removed anchor actually sits at the line
 */
function resolveRemoved(input: GutterHoverLineInput, lineBreak: string): GutterHoverPanelResolution | null {
  if (input.removedOriginals.length === 0) {
    return null;
  }

  const newStart: number = input.line + 1 + (input.removedAfter ? 1 : 0);
  const hunk: Diff.StructuredPatchHunk = {
    oldStart: newStart,
    oldLines: input.removedOriginals.length,
    newStart,
    newLines: 0,
    lines: input.removedOriginals.map((line: string): string => `-${line}`),
  };

  return {
    content: {
      kind: GutterHoverPanelContentKind.removed,
      lines: input.removedOriginals.map(
        (line: string): GutterHoverPanelSegment[] => WordDiffHelper.segments(line, '').map(toSegment),
      ),
      blank: !hasVisibleText(input.removedOriginals),
    },
    hunk,
    baseText: input.removedOriginals.join(lineBreak),
  };
}

/**
 * Whether a block of lines holds any visible (non-whitespace) text. Used to
 * detect a blank or whitespace-only change, which the panel shows as a muted
 * placeholder instead of an empty tinted block.
 *
 * @param {string[]} lines - The block's lines
 * @return {boolean} True when at least one line has a non-whitespace character
 */
function hasVisibleText(lines: string[]): boolean {
  return lines.some((line: string): boolean => line.trim().length > 0);
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
