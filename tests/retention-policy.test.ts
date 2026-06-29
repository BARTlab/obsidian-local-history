import { describe, expect, it } from '@jest/globals';

import { MS_PER_DAY } from '@/consts';
import { RetentionPolicy, type RetentionCaps } from '@/persistence/retention-policy';
import type { SerializedFileSnapshot } from '@/types';

/**
 * Direct unit tests for the pure retention policy extracted from
 * PersistenceService. They drive the two-bucket cap math with controlled
 * fixtures and explicit caps, so live-by-count, tombstone-by-count-and-age, the
 * disabled-cap (0) case, and the newest-first eviction order are verified with
 * no settings, disk, or Obsidian dependency.
 */

const NOW: number = Date.now();

/** Builds a minimal live snapshot at the given timestamp. */
const live = (path: string, timestamp: number): SerializedFileSnapshot => ({
  path,
  lineBreak: '\n',
  timestamp,
  lines: [],
  state: [],
  tracker: [],
});

/** Builds a minimal tombstone with a distinct file and deletion time. */
const tombstone = (
  path: string,
  timestamp: number,
  deletedTimestamp: number,
): SerializedFileSnapshot => ({
  ...live(path, timestamp),
  deletedTimestamp,
});

/** Caps with every dimension disabled unless overridden. */
const caps = (overrides: Partial<RetentionCaps> = {}): RetentionCaps => ({
  maxEntries: 0,
  maxDeletedEntries: 0,
  maxDeletedAgeDays: 0,
  ...overrides,
});

const paths = (snapshots: SerializedFileSnapshot[]): string[] =>
  snapshots.map((item: SerializedFileSnapshot): string => item.path);

describe('RetentionPolicy.apply', (): void => {
  it('returns an empty array for a non-array input', (): void => {
    expect(RetentionPolicy.apply(null as unknown as SerializedFileSnapshot[], caps())).toEqual([]);
  });

  it('skips null entries without throwing', (): void => {
    const input: SerializedFileSnapshot[] = [
      live('a.md', NOW),
      null as unknown as SerializedFileSnapshot,
      live('b.md', NOW - 1000),
    ];

    expect(paths(RetentionPolicy.apply(input, caps()))).toEqual(['a.md', 'b.md']);
  });

  it('caps live files by count, evicting the stalest', (): void => {
    const input: SerializedFileSnapshot[] = [
      live('old.md', NOW - 3000),
      live('mid.md', NOW - 2000),
      live('new.md', NOW - 1000),
    ];

    // Newest first, oldest evicted past the cap.
    expect(paths(RetentionPolicy.apply(input, caps({ maxEntries: 2 })))).toEqual(['new.md', 'mid.md']);
  });

  it('never age-prunes live files (only count bounds them)', (): void => {
    const ancient: SerializedFileSnapshot = live('ancient.md', NOW - 400 * MS_PER_DAY);
    const fresh: SerializedFileSnapshot = live('fresh.md', NOW);

    // A very old but still-present file survives: there is no live age cap.
    const kept: SerializedFileSnapshot[] = RetentionPolicy.apply([ancient, fresh], caps({ maxEntries: 0 }));

    expect(paths(kept)).toEqual(['fresh.md', 'ancient.md']);
  });

  it('caps tombstones by count using the deletion time order', (): void => {
    const input: SerializedFileSnapshot[] = [
      tombstone('t-old.md', NOW, NOW - 3000),
      tombstone('t-new.md', NOW, NOW - 1000),
    ];

    expect(paths(RetentionPolicy.apply(input, caps({ maxDeletedEntries: 1 })))).toEqual(['t-new.md']);
  });

  it('expires tombstones past the deletion age cap', (): void => {
    const stale: SerializedFileSnapshot = tombstone('t-stale.md', NOW, NOW - 3 * MS_PER_DAY);
    const recent: SerializedFileSnapshot = tombstone('t-recent.md', NOW, NOW - (MS_PER_DAY / 2));

    const kept: SerializedFileSnapshot[] = RetentionPolicy.apply(
      [stale, recent],
      caps({ maxDeletedAgeDays: 1 }),
    );

    expect(paths(kept)).toEqual(['t-recent.md']);
  });

  it('ages tombstones by deletedTimestamp, not the original timestamp', (): void => {
    // Old file (timestamp) but just deleted (deletedTimestamp) survives an age cap.
    const justDeletedOldFile: SerializedFileSnapshot = tombstone(
      't.md',
      NOW - 30 * MS_PER_DAY,
      NOW,
    );

    const kept: SerializedFileSnapshot[] = RetentionPolicy.apply(
      [justDeletedOldFile],
      caps({ maxDeletedAgeDays: 1 }),
    );

    expect(paths(kept)).toEqual(['t.md']);
  });

  it('keeps everything when every cap is disabled (0)', (): void => {
    const input: SerializedFileSnapshot[] = [
      live('a.md', NOW),
      live('b.md', NOW - 1000),
      tombstone('t.md', NOW, NOW - 10 * MS_PER_DAY),
    ];

    expect(RetentionPolicy.apply(input, caps())).toHaveLength(3);
  });

  it('returns kept live entries before kept tombstones, each newest first', (): void => {
    const input: SerializedFileSnapshot[] = [
      tombstone('t-old.md', NOW, NOW - 2000),
      live('l-old.md', NOW - 2000),
      tombstone('t-new.md', NOW, NOW - 1000),
      live('l-new.md', NOW - 1000),
    ];

    expect(paths(RetentionPolicy.apply(input, caps()))).toEqual([
      'l-new.md',
      'l-old.md',
      't-new.md',
      't-old.md',
    ]);
  });
});
