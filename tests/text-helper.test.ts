import { describe, expect, it } from '@jest/globals';
import { TextHelper } from '@/helpers/text.helper';
import { TrackerLine } from '@/lines/tracker.line';

/**
 * Regression tests for the collision-free id generator. The previous
 * Math.random based scheme could emit empty, truncated, or colliding ids, which
 * TrackerLine.isEq and key depend on being unique.
 */

describe('TextHelper.rndId', () => {
  it('produces unique, non-empty ids across many calls', () => {
    const count: number = 10000;
    const ids: Set<string> = new Set<string>();

    for (let i: number = 0; i < count; i++) {
      const id: string = TextHelper.rndId();

      expect(id.length).toBeGreaterThan(0);
      ids.add(id);
    }

    expect(ids.size).toBe(count);
  });

  it('applies an optional prefix', () => {
    const id: string = TextHelper.rndId('crn');

    expect(id.startsWith('crn')).toBe(true);
    expect(id.length).toBeGreaterThan('crn'.length);
  });
});

describe('TrackerLine identity', () => {
  it('gives every line a unique id and key', () => {
    const count: number = 1000;
    const ids: Set<string> = new Set<string>();
    const keys: Set<string> = new Set<string>();

    for (let i: number = 0; i < count; i++) {
      const line: TrackerLine = new TrackerLine({
        content: `line ${i}`,
        currentPosition: i,
        originalPosition: i,
      });

      ids.add(line.id);
      keys.add(line.key);
    }

    expect(ids.size).toBe(count);
    expect(keys.size).toBe(count);
  });

  it('keeps key ordering driven by position, not id', () => {
    const low: TrackerLine = new TrackerLine({ content: 'a', currentPosition: 2, originalPosition: 2 });
    const high: TrackerLine = new TrackerLine({ content: 'b', currentPosition: 10, originalPosition: 10 });

    const sorted: string[] = [high.key, low.key].sort(
      (a: string, b: string): number => a.localeCompare(b)
    );

    expect(sorted).toEqual([low.key, high.key]);
  });

  it('treats two lines with distinct ids as not equal', () => {
    const a: TrackerLine = new TrackerLine({ content: 'same', currentPosition: 1, originalPosition: 1 });
    const b: TrackerLine = new TrackerLine({ content: 'same', currentPosition: 1, originalPosition: 1 });

    expect(a.isEq(b)).toBe(false);
    expect(a.isEq(a)).toBe(true);
  });
});
