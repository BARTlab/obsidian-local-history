import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { VERSION_KEYFRAME_INTERVAL } from '@/consts';
import { FileSnapshot } from '@/snapshots/file.snapshot';
import { FileVersion } from '@/snapshots/file.version';
import type { SerializedFileVersion, SnapshotCaptureOptions } from '@/types';

/**
 * Tests for the intermediate-snapshot timeline (T5.2): capture cadence by edit
 * count and elapsed time, the size cap, the pre-edit content contract, and the
 * serialize/restore round-trip of the timeline. These drive FileSnapshot
 * directly so the cadence logic is verified without any editor or Obsidian
 * dependency.
 */

const options = (overrides: Partial<SnapshotCaptureOptions> = {}): SnapshotCaptureOptions => ({
  enabled: true,
  intervalMs: 0,
  editThreshold: 0,
  maxVersions: 0,
  maxVersionAgeDays: 0,
  ...overrides,
});

afterEach((): void => {
  jest.restoreAllMocks();
});

describe('FileSnapshot.captureVersion cadence: edit count', () => {
  it('does not capture on every edit, only once the threshold is reached', () => {
    const snapshot = new FileSnapshot('a');
    const opts = options({ editThreshold: 3 });

    expect(snapshot.captureVersion(['v1'], opts)).toBeNull();
    expect(snapshot.captureVersion(['v2'], opts)).toBeNull();
    expect(snapshot.hasVersions()).toBe(false);

    // Third edit hits the threshold and captures the content passed at that call.
    const captured: FileVersion | null = snapshot.captureVersion(['v3'], opts);

    expect(captured).not.toBeNull();
    expect(snapshot.getVersions()).toHaveLength(1);
    expect(captured?.getLines()).toEqual(['v3']);
  });

  it('resets the edit counter after a capture so versions are evenly spaced', () => {
    const snapshot = new FileSnapshot('a');
    const opts = options({ editThreshold: 2 });

    snapshot.captureVersion(['e1'], opts); // 1, no capture
    snapshot.captureVersion(['e2'], opts); // 2, capture
    snapshot.captureVersion(['e3'], opts); // 1 again, no capture
    snapshot.captureVersion(['e4'], opts); // 2 again, capture

    expect(snapshot.getVersions()).toHaveLength(2);
  });
});

describe('FileSnapshot.captureVersion cadence: elapsed time', () => {
  it('captures only once the time interval has elapsed', () => {
    const base: number = 1_000_000;
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(base);

    // Construction reads Date.now for lastVersionAt; pin it to the base.
    const snapshot = new FileSnapshot('a');
    const opts = options({ intervalMs: 1000 });

    nowSpy.mockReturnValue(base + 500);
    expect(snapshot.captureVersion(['too-soon'], opts)).toBeNull();

    nowSpy.mockReturnValue(base + 1500);
    expect(snapshot.captureVersion(['due'], opts)).not.toBeNull();
    expect(snapshot.getVersions()).toHaveLength(1);
  });

  it('does not capture when both gates are disabled (no spurious versions)', () => {
    const snapshot = new FileSnapshot('a');
    const opts = options({ intervalMs: 0, editThreshold: 0 });

    for (let i = 0; i < 50; i++) {
      snapshot.captureVersion([`edit-${i}`], opts);
    }

    expect(snapshot.hasVersions()).toBe(false);
  });

  it('captures regardless of cadence when forced', () => {
    const snapshot = new FileSnapshot('a');
    const opts = options({ intervalMs: 0, editThreshold: 0 });

    expect(snapshot.captureVersion(['forced'], opts, true)).not.toBeNull();
    expect(snapshot.getVersions()).toHaveLength(1);
  });
});

describe('FileSnapshot.captureVersion guards', () => {
  it('captures nothing when disabled', () => {
    const snapshot = new FileSnapshot('a');

    snapshot.captureVersion(['x'], options({ enabled: false, editThreshold: 1 }), true);

    expect(snapshot.hasVersions()).toBe(false);
  });

  it('ignores non-array content', () => {
    const snapshot = new FileSnapshot('a');

    expect(
      snapshot.captureVersion(null as unknown as string[], options({ editThreshold: 1 }), true)
    ).toBeNull();
    expect(snapshot.hasVersions()).toBe(false);
  });
});

describe('FileSnapshot.captureVersion no-op dedup', () => {
  it('does not store a first version identical to the original baseline', () => {
    const snapshot = new FileSnapshot('a\nb', '\n');
    const opts = options({ editThreshold: 1, maxVersions: 0 });

    // The first qualifying capture freezes the pre-edit state, which still
    // equals the original here, so nothing should be stored.
    expect(snapshot.captureVersion(['a', 'b'], opts)).toBeNull();
    expect(snapshot.hasVersions()).toBe(false);

    // Once the content diverges from the original it is captured normally.
    const captured: FileVersion | null = snapshot.captureVersion(['a', 'B'], opts);
    expect(captured).not.toBeNull();
    expect(snapshot.getVersions()).toHaveLength(1);
    expect(captured?.getLines()).toEqual(['a', 'B']);
  });

  it('skips a capture whose content equals the most recent stored version', () => {
    const snapshot = new FileSnapshot('a', '\n');
    const opts = options({ editThreshold: 1, maxVersions: 0 });

    expect(snapshot.captureVersion(['v1'], opts)).not.toBeNull();
    // Same content as the latest version: no adjacent duplicate is stored.
    expect(snapshot.captureVersion(['v1'], opts)).toBeNull();
    expect(snapshot.getVersions()).toHaveLength(1);

    // A genuinely different edit right after the skipped no-op is captured at
    // once, since the cadence counters were not consumed by the skip.
    expect(snapshot.captureVersion(['v2'], opts)).not.toBeNull();
    expect(snapshot.getVersions().map((v: FileVersion): string[] => v.getLines())).toEqual([
      ['v2'],
      ['v1'],
    ]);
  });

  it('skips a forced capture that duplicates the latest base', () => {
    const snapshot = new FileSnapshot('a', '\n');

    // Forcing bypasses the cadence gates but not the no-op dedup: the original
    // baseline still equals the candidate, so no version is stored.
    expect(snapshot.captureVersion(['a'], options(), true)).toBeNull();
    expect(snapshot.hasVersions()).toBe(false);
  });
});

describe('FileSnapshot timeline bound', () => {
  it('evicts the oldest versions past maxVersions', () => {
    const snapshot = new FileSnapshot('a');
    const opts = options({ editThreshold: 1, maxVersions: 3 });

    for (let i = 1; i <= 6; i++) {
      snapshot.captureVersion([`v${i}`], opts);
    }

    // Only the three newest survive; getVersions returns newest first.
    const versions: FileVersion[] = snapshot.getVersions();
    expect(versions).toHaveLength(3);
    expect(versions.map((version: FileVersion): string[] => version.getLines())).toEqual([
      ['v6'],
      ['v5'],
      ['v4'],
    ]);
  });

  it('keeps every version when maxVersions is 0 (disabled)', () => {
    const snapshot = new FileSnapshot('a');
    const opts = options({ editThreshold: 1, maxVersions: 0 });

    for (let i = 0; i < 10; i++) {
      snapshot.captureVersion([`v${i}`], opts);
    }

    expect(snapshot.getVersions()).toHaveLength(10);
  });
});

describe('FileSnapshot timeline age bound', () => {
  const DAY: number = 24 * 60 * 60 * 1000;

  it('evicts versions older than maxVersionAgeDays on the next capture', () => {
    const base: number = 10_000_000_000;
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(base);

    const snapshot = new FileSnapshot('a');
    const opts = options({ editThreshold: 1, maxVersionAgeDays: 14 });

    // Two captures land 20 days in the past, so they fall outside the 14-day
    // window once "now" advances below.
    nowSpy.mockReturnValue(base - (20 * DAY));
    snapshot.captureVersion(['old-1'], opts);
    snapshot.captureVersion(['old-2'], opts);
    expect(snapshot.getVersions()).toHaveLength(2);

    // A fresh capture at the present time evicts both stale versions (older
    // than 14 days) while keeping the new one.
    nowSpy.mockReturnValue(base);
    const captured: FileVersion | null = snapshot.captureVersion(['fresh'], opts);

    expect(captured).not.toBeNull();
    expect(snapshot.getVersions().map((v: FileVersion): string[] => v.getLines())).toEqual([['fresh']]);
  });

  it('keeps versions within the age window', () => {
    const base: number = 10_000_000_000;
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(base);

    const snapshot = new FileSnapshot('a');
    const opts = options({ editThreshold: 1, maxVersionAgeDays: 14 });

    // One version 10 days old (inside the window), one at the present time.
    nowSpy.mockReturnValue(base - (10 * DAY));
    snapshot.captureVersion(['recent'], opts);

    nowSpy.mockReturnValue(base);
    snapshot.captureVersion(['newest'], opts);

    // Both are within 14 days, so neither is evicted (newest first).
    expect(snapshot.getVersions().map((v: FileVersion): string[] => v.getLines())).toEqual([
      ['newest'],
      ['recent'],
    ]);
  });

  it('disables the age rule when maxVersionAgeDays is 0', () => {
    const base: number = 10_000_000_000;
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(base);

    const snapshot = new FileSnapshot('a');
    const opts = options({ editThreshold: 1, maxVersions: 0, maxVersionAgeDays: 0 });

    // An ancient version stays because the age cap is disabled.
    nowSpy.mockReturnValue(base - (365 * DAY));
    snapshot.captureVersion(['ancient'], opts);

    nowSpy.mockReturnValue(base);
    snapshot.captureVersion(['now'], opts);

    expect(snapshot.getVersions()).toHaveLength(2);
  });

  it('applies age first then the count cap', () => {
    const base: number = 10_000_000_000;
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(base);

    const snapshot = new FileSnapshot('a');
    const opts = options({ editThreshold: 1, maxVersions: 2, maxVersionAgeDays: 14 });

    // One stale version (evicted by age) plus three fresh ones; after age
    // eviction the count cap of 2 keeps only the two newest fresh versions.
    nowSpy.mockReturnValue(base - (30 * DAY));
    snapshot.captureVersion(['stale'], opts);

    nowSpy.mockReturnValue(base);
    snapshot.captureVersion(['fresh-1'], opts);
    snapshot.captureVersion(['fresh-2'], opts);
    snapshot.captureVersion(['fresh-3'], opts);

    expect(snapshot.getVersions().map((v: FileVersion): string[] => v.getLines())).toEqual([
      ['fresh-3'],
      ['fresh-2'],
    ]);
  });
});

describe('FileSnapshot timeline ordering and lookup', () => {
  it('orders getVersions newest first and resolves a version by id', () => {
    const snapshot = new FileSnapshot('a');
    const opts = options({ editThreshold: 1, maxVersions: 0 });

    const first: FileVersion | null = snapshot.captureVersion(['first'], opts);
    const second: FileVersion | null = snapshot.captureVersion(['second'], opts);

    const ordered: FileVersion[] = snapshot.getVersions();
    expect(ordered[0]).toBe(second);
    expect(ordered[1]).toBe(first);

    expect(snapshot.getVersion(first!.id)?.getLines()).toEqual(['first']);
    expect(snapshot.getVersion('missing')).toBeNull();
  });
});

describe('FileSnapshot timeline persistence round-trip', () => {
  it('serializes and restores the timeline with fresh ids', () => {
    const snapshot = new FileSnapshot('a\nb', '\n');
    const opts = options({ editThreshold: 1, maxVersions: 0 });

    // Both captures diverge from the original baseline and from each other, so
    // neither is skipped by the no-op dedup guard.
    snapshot.captureVersion(['a', 'b1'], opts);
    snapshot.captureVersion(['a', 'B'], opts);
    snapshot.updateState(['a', 'B2']);

    const json = snapshot.toJSON();
    expect(json.versions).toHaveLength(2);
    expect(json.versions?.[0]).not.toHaveProperty('id');

    const restored = FileSnapshot.fromJSON(json);

    const restoredVersions: FileVersion[] = restored.getVersions();
    expect(restoredVersions).toHaveLength(2);
    // Newest first: the second captured version leads.
    expect(restoredVersions[0].getLines()).toEqual(['a', 'B']);
    expect(restoredVersions[1].getLines()).toEqual(['a', 'b1']);

    // Ids are regenerated and unique across the restored timeline.
    const ids: string[] = restoredVersions.map((version: FileVersion): string => version.id);
    expect(ids.every((id: string): boolean => typeof id === 'string' && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('tolerates a serialized snapshot without a versions field', () => {
    const snapshot = new FileSnapshot('a\nb', '\n');
    const json = snapshot.toJSON();
    delete json.versions;

    const restored = FileSnapshot.fromJSON(json);

    expect(restored.hasVersions()).toBe(false);
    expect(restored.getVersions()).toEqual([]);
  });
});

describe('FileSnapshot timeline cadence continuity across restart (T15)', () => {
  it('restores lastVersionAt from the newest version timestamp, not load-time', () => {
    /**
     * Build a snapshot at base time, capture two versions in the past, then
     * advance Date.now to a restart moment that is well inside the time gate
     * relative to the newest captured version but already past it relative to
     * the restart itself. After fromJSON the next time-gated check must use
     * the captured timestamp, not the restart time.
     */
    const base: number = 10_000_000_000;
    const intervalMs: number = 60_000;
    const newestCapturedAt: number = base - 30_000;
    const restartAt: number = base;

    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(base - 90_000);

    const snapshot = new FileSnapshot('a', '\n');
    const opts = options({ editThreshold: 1, intervalMs });

    nowSpy.mockReturnValue(base - 60_000);
    snapshot.captureVersion(['v1'], opts);
    nowSpy.mockReturnValue(newestCapturedAt);
    snapshot.captureVersion(['v2'], opts);

    const json = snapshot.toJSON();

    // Restart moment: a fresh FileSnapshot.fromJSON happens now.
    nowSpy.mockReturnValue(restartAt);

    const restored = FileSnapshot.fromJSON(json);

    // 30s after the newest capture, the 60s interval gate must NOT fire yet.
    nowSpy.mockReturnValue(restartAt);
    expect(restored.captureVersion(['too-soon'], options({ intervalMs }))).toBeNull();

    // 31s later we cross the 60s window since the captured timestamp, so the
    // next call must capture. If lastVersionAt had been reset to restart time
    // the gate would still block here, proving the seed is honoured.
    nowSpy.mockReturnValue(newestCapturedAt + intervalMs + 1);
    expect(restored.captureVersion(['due'], options({ intervalMs }))).not.toBeNull();
  });

  it('leaves lastVersionAt at the constructor default when the timeline is empty', () => {
    /**
     * An older history file without any captured versions must round-trip
     * unchanged and behave as before: the constructor seeds lastVersionAt to
     * load-time, so a 1-second interval should not be due immediately.
     */
    const base: number = 20_000_000_000;
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(base);

    const snapshot = new FileSnapshot('a', '\n');
    const json = snapshot.toJSON();
    expect(json.versions).toEqual([]);

    nowSpy.mockReturnValue(base + 500);
    const restored = FileSnapshot.fromJSON(json);

    expect(restored.captureVersion(['x'], options({ intervalMs: 1000 }))).toBeNull();
    expect(restored.hasVersions()).toBe(false);
  });

  it('round-trips an older history payload without versions byte-identically', () => {
    const snapshot = new FileSnapshot('a\nb', '\n');
    const json = snapshot.toJSON();
    delete json.versions;

    const serialized: string = JSON.stringify(json);
    const restored = FileSnapshot.fromJSON(JSON.parse(serialized));
    const reSerialized: string = JSON.stringify(restored.toJSON());

    // Restored payload must not have grown a new lastVersionAt-style field; the
    // versions array re-appears as an empty list (constructor default), so
    // compare without it on the restored side.
    const reParsed = JSON.parse(reSerialized);
    expect(reParsed.versions).toEqual([]);
    delete reParsed.versions;
    expect(reParsed).toEqual(json);
  });
});

describe('FileSnapshot.removeVersion', () => {
  it('removes a single version by id and leaves the rest of the timeline', () => {
    const snapshot = new FileSnapshot('a', '\n');
    const opts = options({ editThreshold: 1 });

    snapshot.captureVersion(['v1'], opts);
    snapshot.captureVersion(['v2'], opts);
    snapshot.captureVersion(['v3'], opts);

    // getVersions is newest-first: [v3, v2, v1]. Drop the middle one.
    const middleId: string = snapshot.getVersions()[1].id;

    expect(snapshot.removeVersion(middleId)).toBe(true);
    expect(snapshot.getVersions().map((v: FileVersion): string[] => v.getLines())).toEqual([
      ['v3'],
      ['v1'],
    ]);
    expect(snapshot.getVersion(middleId)).toBeNull();
  });

  it('returns false and changes nothing when no version matches the id', () => {
    const snapshot = new FileSnapshot('a', '\n');
    snapshot.captureVersion(['v1'], options({ editThreshold: 1 }));

    expect(snapshot.removeVersion('does-not-exist')).toBe(false);
    expect(snapshot.getVersions()).toHaveLength(1);
  });
});

describe('FileSnapshot version codec wiring (T05)', () => {
  it('round-trips lines, timestamp, label and external through the codec', () => {
    const snapshot = new FileSnapshot('a\nb', '\n');
    const opts = options({ editThreshold: 1, maxVersions: 0 });

    snapshot.captureVersion(['a', 'b1'], opts);
    snapshot.captureVersion(['a', 'B'], opts, true, 'milestone');
    snapshot.captureVersion(['a', 'B', 'c'], opts, true);
    // Flag the newest captured version as external so the round-trip carries it.
    snapshot.versions[snapshot.versions.length - 1].external = true;

    const restored = FileSnapshot.fromJSON(snapshot.toJSON());

    // Oldest-first comparison so the decoded delta chain lines up with capture.
    expect(restored.versions.map((v: FileVersion): string[] => v.getLines())).toEqual([
      ['a', 'b1'],
      ['a', 'B'],
      ['a', 'B', 'c'],
    ]);
    expect(restored.versions.map((v: FileVersion): number => v.timestamp)).toEqual(
      snapshot.versions.map((v: FileVersion): number => v.timestamp),
    );
    expect(restored.versions[1].label).toBe('milestone');
    expect(restored.versions[2].isExternal()).toBe(true);
    expect(restored.versions[0].isLabeled()).toBe(false);
    expect(restored.versions[0].isExternal()).toBe(false);
  });

  it('engages the codec: a chain longer than the keyframe interval emits deltas', () => {
    const snapshot = new FileSnapshot('line-0', '\n');
    const opts = options({ editThreshold: 1, maxVersions: 0 });

    // One more than the interval so at least one entry must be a delta.
    const count: number = VERSION_KEYFRAME_INTERVAL + 1;

    // Build each version as 19 shared lines plus one tail line that changes.
    // The large shared body keeps the unified-diff (including its fixed header
    // overhead) below the full-text join length, so encode() keeps delta form.
    const sharedLines: string[] = Array.from(
      { length: 19 },
      (_u: unknown, k: number): string => `shared-content-line-${k.toString().padStart(3, '0')}`,
    );

    for (let i = 1; i <= count; i++) {
      snapshot.captureVersion([...sharedLines, `tail-${i}`], opts);
    }

    expect(snapshot.versions).toHaveLength(count);

    const entries: SerializedFileVersion[] | undefined = snapshot.toJSON().versions;
    expect(entries).toHaveLength(count);

    const deltas = (entries ?? []).filter(
      (entry: SerializedFileVersion): boolean => typeof entry.delta === 'string',
    );

    const keyframes = (entries ?? []).filter(
      (entry: SerializedFileVersion): boolean => Array.isArray(entry.lines),
    );

    // Index 0 and index VERSION_KEYFRAME_INTERVAL are keyframes; the rest deltas.
    expect(keyframes.length).toBe(2);
    expect(deltas.length).toBe(count - 2);

    // The delta-bearing payload still restores every version verbatim.
    const restored = FileSnapshot.fromJSON(snapshot.toJSON());
    expect(restored.versions.map((v: FileVersion): string[] => v.getLines())).toEqual(
      snapshot.versions.map((v: FileVersion): string[] => v.getLines()),
    );
  });

  it('restores an all-keyframe (version-1) versions array unchanged', () => {
    const snapshot = new FileSnapshot('seed', '\n');
    const json = snapshot.toJSON();

    // Hand-build a legacy v1 payload: every entry carries full lines, no deltas.
    json.versions = [
      { timestamp: 100, lines: ['a'] },
      { timestamp: 200, lines: ['a', 'b'], label: 'tag' },
      { timestamp: 300, lines: ['a', 'b', 'c'], external: true },
    ];

    const restored = FileSnapshot.fromJSON(json);

    expect(restored.versions.map((v: FileVersion): string[] => v.getLines())).toEqual([
      ['a'],
      ['a', 'b'],
      ['a', 'b', 'c'],
    ]);
    expect(restored.versions.map((v: FileVersion): number => v.timestamp)).toEqual([100, 200, 300]);
    expect(restored.versions[1].label).toBe('tag');
    expect(restored.versions[2].isExternal()).toBe(true);
  });

  it('decodes to [] when versions is undefined without throwing', () => {
    const snapshot = new FileSnapshot('a\nb', '\n');
    const json = snapshot.toJSON();
    json.versions = undefined;

    let restored!: FileSnapshot;
    expect((): void => {
      restored = FileSnapshot.fromJSON(json);
    }).not.toThrow();
    expect(restored.versions).toEqual([]);
    expect(restored.hasVersions()).toBe(false);
  });
});

describe('FileVersion', () => {
  it('joins content with the given line break and copies its lines', () => {
    const version = new FileVersion(['x', 'y'], 42);

    expect(version.getContent('\r\n')).toBe('x\r\ny');
    expect(version.timestamp).toBe(42);

    const lines: string[] = version.getLines();
    lines.push('mutated');
    expect(version.getLines()).toEqual(['x', 'y']);
  });
});
