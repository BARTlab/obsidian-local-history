import { describe, expect, it } from 'vitest';
import type { Change } from 'diff';
import * as WordDiffHelper from '@/helpers/word-diff.helper';
import { WORD_DIFF_LENGTH_THRESHOLD, WORD_DIFF_PAIRING_THRESHOLD } from '@/consts';
import type { InlineDiffLine } from '@/types';

/**
 * Tests for the intra-line (word) diff logic. They drive WordDiffHelper
 * directly, which is the pure unit the history modal delegates to when it
 * renders the inline word diff. Two guarantees are under test:
 * - segments() splits a modified line into word-level pieces flagged
 *   added/removed/unchanged, including the empty-side and identical-line edges,
 *   so the modal can highlight only the changed words, and
 * - lines() pairs a removed block with the added block that follows it so a
 *   genuinely modified line is detected, while pure additions and removals stay
 *   whole and surplus lines on either side fall back to pure add/remove.
 */
describe('WordDiffHelper.segments', () => {
  it('flags only the changed words inside a modified line', () => {
    const segments: Change[] = WordDiffHelper.segments('hello world foo', 'hello brave world bar');

    // Unchanged words carry neither flag; the inserted and deleted words do.
    expect(segments.find((s: Change): boolean => s.value.includes('brave'))?.added).toBe(true);
    expect(segments.find((s: Change): boolean => s.value.includes('bar'))?.added).toBe(true);
    expect(segments.find((s: Change): boolean => s.value.includes('foo'))?.removed).toBe(true);

    const hello: Change | undefined = segments.find((s: Change): boolean => s.value.includes('hello'));

    expect(hello?.added).toBeFalsy();
    expect(hello?.removed).toBeFalsy();
  });

  it('yields a single added segment when the old side is empty', () => {
    const segments: Change[] = WordDiffHelper.segments('', 'brand new');

    expect(segments).toHaveLength(1);
    expect(segments[0].added).toBe(true);
    expect(segments[0].value).toBe('brand new');
  });

  it('yields a single removed segment when the new side is empty', () => {
    const segments: Change[] = WordDiffHelper.segments('was here', '');

    expect(segments).toHaveLength(1);
    expect(segments[0].removed).toBe(true);
    expect(segments[0].value).toBe('was here');
  });

  it('yields a single unchanged segment for identical lines', () => {
    const segments: Change[] = WordDiffHelper.segments('same line', 'same line');

    expect(segments).toHaveLength(1);
    expect(segments[0].added).toBeFalsy();
    expect(segments[0].removed).toBeFalsy();
    expect(segments[0].value).toBe('same line');
  });

  it('treats null inputs as empty strings', () => {
    expect(WordDiffHelper.segments(null as never, null as never)).toEqual([]);
  });

  it('short-circuits to one removed + one added when combined length exceeds threshold', () => {
    const longLine: string = 'x'.repeat(WORD_DIFF_LENGTH_THRESHOLD);
    const segments: Change[] = WordDiffHelper.segments(longLine, longLine + 'y');

    expect(segments).toHaveLength(2);
    expect(segments[0].removed).toBe(true);
    expect(segments[0].value).toBe(longLine);
    expect(segments[1].added).toBe(true);
    expect(segments[1].value).toBe(longLine + 'y');
  });

  it('does not short-circuit when combined length equals the threshold', () => {
    // Exactly at the boundary: oldText.length + newText.length === threshold.
    // The guard uses strict >, so threshold itself goes through Diff.diffWords.
    const half: string = 'a'.repeat(WORD_DIFF_LENGTH_THRESHOLD / 2);
    const segments: Change[] = WordDiffHelper.segments(half, half);

    // Identical strings -> single unchanged segment from Diff.diffWords.
    expect(segments).toHaveLength(1);
    expect(segments[0].added).toBeFalsy();
    expect(segments[0].removed).toBeFalsy();
  });

  it('returns only an added segment when the old side is empty and new side exceeds threshold', () => {
    const longLine: string = 'z'.repeat(WORD_DIFF_LENGTH_THRESHOLD + 1);
    const segments: Change[] = WordDiffHelper.segments('', longLine);

    expect(segments).toHaveLength(1);
    expect(segments[0].added).toBe(true);
    expect(segments[0].value).toBe(longLine);
  });
});

describe('WordDiffHelper.lines', () => {
  it('marks unchanged lines as context with both sides set', () => {
    const lines: InlineDiffLine[] = WordDiffHelper.lines('a\nb\nc', 'a\nb\nc');

    expect(lines).toEqual([
      { type: 'context', oldText: 'a', newText: 'a' },
      { type: 'context', oldText: 'b', newText: 'b' },
      { type: 'context', oldText: 'c', newText: 'c' },
    ]);
  });

  it('pairs a removed line with the following added line as a modification', () => {
    const lines: InlineDiffLine[] = WordDiffHelper.lines('a\nold\nc', 'a\nnew\nc');

    expect(lines).toEqual([
      { type: 'context', oldText: 'a', newText: 'a' },
      { type: 'modified', oldText: 'old', newText: 'new' },
      { type: 'context', oldText: 'c', newText: 'c' },
    ]);
  });

  it('keeps a pure insertion whole', () => {
    const lines: InlineDiffLine[] = WordDiffHelper.lines('a\nb', 'a\nNEW\nb');

    expect(lines).toEqual([
      { type: 'context', oldText: 'a', newText: 'a' },
      { type: 'added', newText: 'NEW' },
      { type: 'context', oldText: 'b', newText: 'b' },
    ]);
  });

  it('keeps a pure deletion whole', () => {
    const lines: InlineDiffLine[] = WordDiffHelper.lines('a\nGONE\nc', 'a\nc');

    expect(lines).toEqual([
      { type: 'context', oldText: 'a', newText: 'a' },
      { type: 'removed', oldText: 'GONE' },
      { type: 'context', oldText: 'c', newText: 'c' },
    ]);
  });

  it('pairs by position and turns surplus old lines into pure removals', () => {
    // Two removed lines, one added line: the first pairs, the second is removed.
    const lines: InlineDiffLine[] = WordDiffHelper.lines('x1\nx2\ntail', 'y1\ntail');

    expect(lines).toEqual([
      { type: 'modified', oldText: 'x1', newText: 'y1' },
      { type: 'removed', oldText: 'x2' },
      { type: 'context', oldText: 'tail', newText: 'tail' },
    ]);
  });

  it('pairs by position and turns surplus new lines into pure additions', () => {
    // One removed line, two added lines: the first pairs, the second is added.
    const lines: InlineDiffLine[] = WordDiffHelper.lines('x1\ntail', 'y1\ny2\ntail');

    expect(lines).toEqual([
      { type: 'modified', oldText: 'x1', newText: 'y1' },
      { type: 'added', newText: 'y2' },
      { type: 'context', oldText: 'tail', newText: 'tail' },
    ]);
  });

  it('detects a modification on the first line', () => {
    const lines: InlineDiffLine[] = WordDiffHelper.lines('old first\nb', 'new first\nb');

    expect(lines[0]).toEqual({ type: 'modified', oldText: 'old first', newText: 'new first' });
  });

  it('detects a modification on the last line', () => {
    const lines: InlineDiffLine[] = WordDiffHelper.lines('a\nold last', 'a\nnew last');

    expect(lines[lines.length - 1]).toEqual({ type: 'modified', oldText: 'old last', newText: 'new last' });
  });

  it('returns no lines for two empty texts', () => {
    expect(WordDiffHelper.lines('', '')).toEqual([]);
  });

  it('treats null inputs as empty strings', () => {
    expect(WordDiffHelper.lines(null as never, null as never)).toEqual([]);
  });

  it('pairs reordered lines by similarity rather than position', () => {
    // lineA = "the quick brown fox", lineB = "hello world foo bar"
    // added in reversed order: lineB' first, lineA' second.
    // Similarity pairing should match lineA with lineA' and lineB with lineB'.
    const base: string = 'the quick brown fox\nhello world foo bar';
    const current: string = 'hello world foo baz\nthe quick brown cat';

    const result: InlineDiffLine[] = WordDiffHelper.lines(base, current);

    expect(result).toHaveLength(2);
    // First removed line pairs with most similar added line (highest word overlap).
    expect(result[0]).toEqual({ type: 'modified', oldText: 'the quick brown fox', newText: 'the quick brown cat' });
    expect(result[1]).toEqual({ type: 'modified', oldText: 'hello world foo bar', newText: 'hello world foo baz' });
  });

  it('falls back to positional pairing when a block exceeds the threshold', () => {
    // Build blocks larger than WORD_DIFF_PAIRING_THRESHOLD.
    const removedLines: string[] = Array.from(
      { length: WORD_DIFF_PAIRING_THRESHOLD + 1 },
      (_: unknown, i: number): string => `removed line ${i}`,
    );

    const addedLines: string[] = Array.from(
      { length: WORD_DIFF_PAIRING_THRESHOLD + 1 },
      (_: unknown, i: number): string => `added line ${i}`,
    );

    const base: string = removedLines.join('\n');
    const current: string = addedLines.join('\n');

    const result: InlineDiffLine[] = WordDiffHelper.lines(base, current);

    // Every line should be modified (positional pairing: same length blocks).
    expect(result).toHaveLength(WORD_DIFF_PAIRING_THRESHOLD + 1);

    result.forEach((line: InlineDiffLine, i: number): void => {
      expect(line.type).toBe('modified');
      expect(line.oldText).toBe(`removed line ${i}`);
      expect(line.newText).toBe(`added line ${i}`);
    });
  });
});
