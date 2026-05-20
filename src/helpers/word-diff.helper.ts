import { WordDiffLineType } from '@/consts';
import * as Diff from 'diff';

/**
 * One line of an inline diff. A line is either unchanged context, a pure
 * addition, a pure removal, or a modification (a removed and added pair that
 * represent the same logical line). For a modified line both the old and the
 * new text are kept so the renderer can show word-level spans for each side.
 */
export interface InlineDiffLine {
  /** The kind of change this line represents */
  type: WordDiffLineType;
  /** The old (base) text of the line, present for context, removed, modified */
  oldText?: string;
  /** The new (current) text of the line, present for context, added, modified */
  newText?: string;
}

/**
 * Helper for intra-line (word-level) diffing used by the history modal.
 *
 * Two concerns, both pure and free of any DOM or Obsidian dependency so they
 * can be unit tested directly:
 * - {@link segments} splits a pair of lines into word-level segments, each
 *   flagged as added, removed, or unchanged. This is what lets the modal
 *   highlight only the changed words inside a modified line instead of marking
 *   the whole line.
 * - {@link lines} turns a base and a current text into an ordered list of
 *   inline diff lines, pairing a removed block with the added block that
 *   immediately follows it so genuinely modified lines are detected (and later
 *   word-diffed), while pure additions and removals stay whole.
 */
export class WordDiffHelper {
  /**
   * Splits a pair of lines into word-level segments. Each segment carries its
   * text and whether it was added (present only in the new line), removed
   * (present only in the old line), or unchanged (shared by both). An empty
   * side yields a single added or removed segment for the non-empty side, and
   * two identical lines yield a single unchanged segment.
   *
   * @param {string} oldText - The old (base) line text
   * @param {string} newText - The new (current) line text
   * @return {Diff.Change[]} Ordered word-level segments
   */
  public static segments(oldText: string, newText: string): Diff.Change[] {
    return Diff.diffWords(oldText ?? '', newText ?? '');
  }

  /**
   * Turns a base text and a current text into an ordered list of inline diff
   * lines. A removed block immediately followed by an added block is treated as
   * a modification: the lines are paired by position so each pair can be word
   * diffed later. Any surplus old lines in the block become pure removals and
   * any surplus new lines become pure additions. A removed block with no added
   * block after it stays a pure removal, and an added block with no removed
   * block before it stays a pure addition.
   *
   * @param {string} base - The base (older) content
   * @param {string} current - The current (newer) content
   * @return {InlineDiffLine[]} The inline diff lines, ordered top to bottom
   */
  public static lines(base: string, current: string): InlineDiffLine[] {
    const changes: Diff.Change[] = Diff.diffLines(base ?? '', current ?? '');
    const result: InlineDiffLine[] = [];

    for (let index: number = 0; index < changes.length; index++) {
      const change: Diff.Change = changes[index];

      if (!change.added && !change.removed) {
        WordDiffHelper.splitLines(change.value).forEach((text: string): void => {
          result.push({ type: WordDiffLineType.context, oldText: text, newText: text });
        });

        continue;
      }

      // A removed block paired with the added block that follows it is a
      // modification: emit one modified line per matching position.
      if (change.removed) {
        const next: Diff.Change | undefined = changes[index + 1];
        const removedLines: string[] = WordDiffHelper.splitLines(change.value);

        if (next?.added) {
          const addedLines: string[] = WordDiffHelper.splitLines(next.value);
          const paired: number = Math.min(removedLines.length, addedLines.length);

          for (let i: number = 0; i < paired; i++) {
            result.push({ type: WordDiffLineType.modified, oldText: removedLines[i], newText: addedLines[i] });
          }

          // Surplus old lines are pure removals, surplus new lines pure additions.
          for (let i: number = paired; i < removedLines.length; i++) {
            result.push({ type: WordDiffLineType.removed, oldText: removedLines[i] });
          }

          for (let i: number = paired; i < addedLines.length; i++) {
            result.push({ type: WordDiffLineType.added, newText: addedLines[i] });
          }

          // The added block was consumed as the pair, skip it on the next turn.
          index++;

          continue;
        }

        removedLines.forEach((text: string): void => {
          result.push({ type: WordDiffLineType.removed, oldText: text });
        });

        continue;
      }

      // An added block with no removed block before it is a pure addition.
      WordDiffHelper.splitLines(change.value).forEach((text: string): void => {
        result.push({ type: WordDiffLineType.added, newText: text });
      });
    }

    return result;
  }

  /**
   * Splits a diff block value into its constituent lines. The diff library
   * appends a trailing newline to every block, which would otherwise yield a
   * spurious empty final line, so a single trailing newline is dropped before
   * splitting.
   *
   * @param {string} value - The raw block value from the diff library
   * @return {string[]} The lines of the block
   */
  protected static splitLines(value: string): string[] {
    if (value === '') {
      return [];
    }

    const normalized: string = value.endsWith('\n') ? value.slice(0, -1) : value;

    return normalized.split('\n');
  }
}
