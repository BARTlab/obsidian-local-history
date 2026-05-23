import { describe, expect, it } from '@jest/globals';
import type { Change } from 'diff';
import { WordDiffHelper } from '@/helpers/word-diff.helper';
import type { InlineDiffLine } from '@/types';

/**
 * Tests for the intra-line (word) diff logic (T5.5). They drive WordDiffHelper
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
});
