import { WordDiffLineType, WORD_DIFF_LENGTH_THRESHOLD, WORD_DIFF_PAIRING_THRESHOLD } from '@/consts';
import * as TextHelper from '@/helpers/text.helper';
import type { InlineDiffLine } from '@/types';
import * as Diff from 'diff';

/**
 * Helpers for intra-line (word-level) diffing used by the history modal.
 *
 * Two concerns, both pure and free of any DOM or Obsidian dependency so they
 * can be unit tested directly:
 * - {@link segments} splits a pair of lines into word-level segments, each
 *   flagged as added, removed, or unchanged. This is what lets the modal
 *   highlight only the changed words inside a modified line instead of marking
 *   the whole line.
 * - {@link lines} turns a base and a current text into an ordered list of
 *   inline diff lines. When the removed and added blocks are both at most
 *   {@link WORD_DIFF_PAIRING_THRESHOLD} lines, lines are paired by word-overlap
 *   similarity (greedy best-match) so reordered edits produce correct modified
 *   pairs. Larger blocks fall back to positional pairing to cap O(n*m) work.
 */

/**
 * Splits a pair of lines into word-level segments. Each segment carries its
 * text and whether it was added (present only in the new line), removed
 * (present only in the old line), or unchanged (shared by both). An empty
 * side yields a single added or removed segment for the non-empty side, and
 * two identical lines yield a single unchanged segment.
 *
 * When the combined character length of both sides exceeds
 * {@link WORD_DIFF_LENGTH_THRESHOLD}, the O(n*m) diff is skipped entirely:
 * the function returns one removed segment for the old text and one added
 * segment for the new text. This keeps the modal responsive on very long
 * lines (minified JS, base64 blobs) while preserving full word-diff quality
 * for all normal lines.
 *
 * @param {string} oldText - The old (base) line text
 * @param {string} newText - The new (current) line text
 * @return {Diff.Change[]} Ordered word-level segments
 */
export function segments(oldText: string, newText: string): Diff.Change[] {
  const old: string = oldText ?? '';
  const next: string = newText ?? '';

  if (old.length + next.length > WORD_DIFF_LENGTH_THRESHOLD) {
    const result: Diff.Change[] = [];

    if (old.length > 0) {
      result.push({ value: old, removed: true, added: false, count: 1 });
    }

    if (next.length > 0) {
      result.push({ value: next, added: true, removed: false, count: 1 });
    }

    return result;
  }

  return Diff.diffWords(old, next);
}

/**
 * Turns a base text and a current text into an ordered list of inline diff
 * lines. A removed block immediately followed by an added block is treated as
 * a modification. When both blocks are at most {@link WORD_DIFF_PAIRING_THRESHOLD}
 * lines, similarity-based greedy matching pairs each removed line with the most
 * similar added line (by word-overlap ratio). This corrects false "modified" pairs
 * caused by reordered-line edits. When either block exceeds the threshold, lines
 * fall back to positional pairing to bound O(n*m) scoring work. Any surplus old
 * lines in the block become pure removals and any surplus new lines become pure
 * additions. A removed block with no added block after it stays a pure removal,
 * and an added block with no removed block before it stays a pure addition.
 *
 * @param {string} base - The base (older) content
 * @param {string} current - The current (newer) content
 * @return {InlineDiffLine[]} The inline diff lines, ordered top to bottom
 */
export function lines(base: string, current: string): InlineDiffLine[] {
  const changes: Diff.Change[] = Diff.diffLines(base ?? '', current ?? '');
  const result: InlineDiffLine[] = [];

  for (let index: number = 0; index < changes.length; index++) {
    const change: Diff.Change = changes[index];

    if (!change.added && !change.removed) {
      splitLines(change.value).forEach((text: string): void => {
        result.push({ type: WordDiffLineType.context, oldText: text, newText: text });
      });

      continue;
    }

    /**
     * A removed block paired with the added block that follows it is a
     * modification: pair lines by similarity when both blocks are small.
     */
    if (change.removed) {
      const next: Diff.Change | undefined = changes[index + 1];
      const removedLines: string[] = splitLines(change.value);

      if (next?.added) {
        const addedLines: string[] = splitLines(next.value);

        pairAndEmit(removedLines, addedLines, result);

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
    splitLines(change.value).forEach((text: string): void => {
      result.push({ type: WordDiffLineType.added, newText: text });
    });
  }

  return result;
}

/**
 * Pairs removed lines with added lines and appends the resulting
 * {@link InlineDiffLine} entries to `result`. When both blocks are within
 * {@link WORD_DIFF_PAIRING_THRESHOLD}, a greedy similarity match is used.
 * Otherwise lines are paired by array position.
 *
 * Greedy algorithm (O(n*m)):
 * 1. Score every (removed_i, added_j) pair with {@link wordOverlapRatio}.
 * 2. Pick the highest-scoring pair, record it, remove both from the pool.
 * 3. Repeat until no candidates remain.
 * 4. Remaining unmatched lines are emitted as pure removals or additions.
 * 5. Emit all pairs sorted by their original removed-line index for stable
 *    top-to-bottom rendering order.
 *
 * @param {string[]} removedLines - Lines from the removed block
 * @param {string[]} addedLines - Lines from the added block
 * @param {InlineDiffLine[]} result - Array to append results to
 */
function pairAndEmit(removedLines: string[], addedLines: string[], result: InlineDiffLine[]): void {
  const useGreedy: boolean =
    removedLines.length <= WORD_DIFF_PAIRING_THRESHOLD && addedLines.length <= WORD_DIFF_PAIRING_THRESHOLD;

  if (!useGreedy) {
    positionalPair(removedLines, addedLines, result);

    return;
  }

  greedyPair(removedLines, addedLines, result);
}

/**
 * Pairs lines by position (original behaviour). The shorter block determines
 * how many modified pairs are emitted; surplus lines from either side become
 * pure removals or additions.
 */
function positionalPair(removedLines: string[], addedLines: string[], result: InlineDiffLine[]): void {
  const paired: number = Math.min(removedLines.length, addedLines.length);

  for (let i: number = 0; i < paired; i++) {
    result.push({ type: WordDiffLineType.modified, oldText: removedLines[i], newText: addedLines[i] });
  }

  for (let i: number = paired; i < removedLines.length; i++) {
    result.push({ type: WordDiffLineType.removed, oldText: removedLines[i] });
  }

  for (let i: number = paired; i < addedLines.length; i++) {
    result.push({ type: WordDiffLineType.added, newText: addedLines[i] });
  }
}

/**
 * Pairs lines by greedy best-match on word-overlap similarity. Pairs are
 * emitted in ascending order of the original removed-line index.
 */
function greedyPair(removedLines: string[], addedLines: string[], result: InlineDiffLine[]): void {
  const availableAdded: Set<number> = new Set(addedLines.map((_: string, i: number): number => i));
  const pairs: { removedIdx: number; addedIdx: number }[] = [];
  const unmatchedRemoved: number[] = [];

  for (let ri: number = 0; ri < removedLines.length; ri++) {
    let bestScore: number = -1;
    let bestAi: number = -1;

    for (const ai of availableAdded) {
      const score: number = wordOverlapRatio(removedLines[ri], addedLines[ai]);

      if (score > bestScore) {
        bestScore = score;
        bestAi = ai;
      }
    }

    if (bestAi >= 0) {
      pairs.push({ removedIdx: ri, addedIdx: bestAi });
      availableAdded.delete(bestAi);
    } else {
      unmatchedRemoved.push(ri);
    }
  }

  // Sort pairs by removed-line position for stable rendering order.
  pairs.sort((a: { removedIdx: number; addedIdx: number }, b: { removedIdx: number; addedIdx: number }): number =>
    a.removedIdx - b.removedIdx,
  );

  // Emit pairs as modified lines interleaved with unmatched removals in
  // original removed-line order.
  let unmatchedRemovedIdx: number = 0;

  for (const pair of pairs) {
    // Emit any pure removals that appear before this pair in the original order.
    while (
      unmatchedRemovedIdx < unmatchedRemoved.length &&
      unmatchedRemoved[unmatchedRemovedIdx] < pair.removedIdx
    ) {
      result.push({ type: WordDiffLineType.removed, oldText: removedLines[unmatchedRemoved[unmatchedRemovedIdx]] });
      unmatchedRemovedIdx++;
    }

    result.push({
      type: WordDiffLineType.modified,
      oldText: removedLines[pair.removedIdx],
      newText: addedLines[pair.addedIdx],
    });
  }

  // Emit remaining unmatched removals.
  while (unmatchedRemovedIdx < unmatchedRemoved.length) {
    result.push({ type: WordDiffLineType.removed, oldText: removedLines[unmatchedRemoved[unmatchedRemovedIdx]] });
    unmatchedRemovedIdx++;
  }

  // Emit unmatched additions in their original order.
  for (const ai of Array.from(availableAdded).sort((a: number, b: number): number => a - b)) {
    result.push({ type: WordDiffLineType.added, newText: addedLines[ai] });
  }
}

/**
 * Computes the word-overlap ratio between two lines. The metric is the
 * Jaccard similarity of the two lines' word multisets: the size of the
 * intersection divided by the size of the union. Words are extracted by
 * splitting on whitespace. An empty-vs-empty pair returns 0 (no similarity
 * signal; treat as unmatched rather than trivially equal).
 *
 * The choice of word-overlap ratio over normalized Levenshtein is deliberate:
 * it is O(n+m) in the number of words (after building a frequency map) and
 * captures semantic similarity better than character-edit distance for typical
 * prose and identifier-heavy code lines.
 *
 * @param {string} a - First line
 * @param {string} b - Second line
 * @return {number} Similarity in [0, 1]; higher means more similar
 */
function wordOverlapRatio(a: string, b: string): number {
  const wordsA: string[] = a.trim().split(/\s+/).filter(Boolean);
  const wordsB: string[] = b.trim().split(/\s+/).filter(Boolean);

  if (wordsA.length === 0 && wordsB.length === 0) {
    return 0;
  }

  const freqA: Map<string, number> = new Map();

  for (const w of wordsA) {
    freqA.set(w, (freqA.get(w) ?? 0) + 1);
  }

  let intersection: number = 0;

  for (const w of wordsB) {
    const countA: number = freqA.get(w) ?? 0;

    if (countA > 0) {
      intersection++;
      freqA.set(w, countA - 1);
    }
  }

  const union: number = wordsA.length + wordsB.length - intersection;

  return union === 0 ? 0 : intersection / union;
}

/**
 * Splits a diff block value into its constituent lines. The diff library
 * appends a trailing newline to every block, which would otherwise yield a
 * spurious empty final line, so a single trailing newline is dropped before
 * the shared {@link TextHelper.splitLines} decomposes the block. This is a
 * diff-block adapter around that invariant, not a second copy of it: the empty
 * guard and trailing-newline strip are specific to the diff library's blocks
 * and must not leak into plain document decomposition.
 *
 * @param {string} value - The raw block value from the diff library
 * @return {string[]} The lines of the block
 */
function splitLines(value: string): string[] {
  if (value === '') {
    return [];
  }

  const normalized: string = value.replace(/\r?\n$/, '');

  return TextHelper.splitLines(normalized);
}
