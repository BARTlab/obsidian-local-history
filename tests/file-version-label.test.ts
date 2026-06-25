import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { FileSnapshot } from '@/snapshots/file.snapshot';
import { FileVersion } from '@/snapshots/file.version';
import type { SerializedFileVersion, SnapshotCaptureOptions } from '@/types';

/**
 * Tests for the optional user-supplied label on FileVersion. A label
 * pins a version: it round-trips through toJSON/fromJSON, it bypasses the
 * captureVersion no-op dedup so the marker is always recorded, and it
 * survives both eviction passes (age and count) regardless of how old the
 * version is or how many later versions accumulate.
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

describe('FileVersion label round-trip', () => {
  it('persists and rebuilds a non-empty label intact', () => {
    const version = new FileVersion(['x'], 42, 'milestone-1');

    expect(version.label).toBe('milestone-1');
    expect(version.isLabeled()).toBe(true);

    const json: SerializedFileVersion = version.toJSON();
    expect(json.label).toBe('milestone-1');

    const restored: FileVersion = FileVersion.fromJSON(json);
    expect(restored.label).toBe('milestone-1');
    expect(restored.isLabeled()).toBe(true);
    expect(restored.getLines()).toEqual(['x']);
  });

  it('omits the label field for an unlabeled version', () => {
    const version = new FileVersion(['y']);

    expect(version.label).toBeUndefined();
    expect(version.isLabeled()).toBe(false);

    const json: SerializedFileVersion = version.toJSON();
    expect(json).not.toHaveProperty('label');

    const restored: FileVersion = FileVersion.fromJSON(json);
    expect(restored.label).toBeUndefined();
    expect(restored.isLabeled()).toBe(false);
  });

  it('treats an empty label as no label at all', () => {
    const version = new FileVersion(['z'], 1, '');

    expect(version.label).toBeUndefined();
    expect(version.isLabeled()).toBe(false);
    expect(version.toJSON()).not.toHaveProperty('label');
  });
});

describe('FileSnapshot.captureVersion: label bypasses the duplicate-skip', () => {
  it('captures a labeled version even when content duplicates the latest base', () => {
    const snapshot = new FileSnapshot('a', '\n');
    const opts = options({ editThreshold: 1 });

    // Sanity check: an unlabeled forced capture of the baseline is skipped.
    expect(snapshot.captureVersion(['a'], opts, true)).toBeNull();
    expect(snapshot.hasVersions()).toBe(false);

    // A labeled capture of the very same content is recorded as a pinned marker.
    const captured: FileVersion | null = snapshot.captureVersion(['a'], opts, true, 'pin');
    expect(captured).not.toBeNull();
    expect(captured?.isLabeled()).toBe(true);
    expect(captured?.label).toBe('pin');
    expect(snapshot.getVersions()).toHaveLength(1);
  });

  it('still records a labeled capture when the latest stored version has the same content', () => {
    const snapshot = new FileSnapshot('a', '\n');
    const opts = options({ editThreshold: 1 });

    expect(snapshot.captureVersion(['v1'], opts)).not.toBeNull();
    // Unlabeled duplicate is skipped, labeled duplicate is recorded.
    expect(snapshot.captureVersion(['v1'], opts)).toBeNull();
    expect(snapshot.captureVersion(['v1'], opts, false, 'tag')).not.toBeNull();
    expect(snapshot.getVersions()).toHaveLength(2);
    // Newest first: the labeled one leads.
    expect(snapshot.getVersions()[0].isLabeled()).toBe(true);
  });
});

describe('FileVersion external flag round-trip', () => {
  it('defaults to undefined/falsey with isExternal() returning false', () => {
    const version = new FileVersion(['a'], 1);

    expect(version.external).toBeUndefined();
    expect(version.isExternal()).toBe(false);
  });

  it('reports isExternal() true when constructed as external', () => {
    const version = new FileVersion(['a'], 1, undefined, true);

    expect(version.external).toBe(true);
    expect(version.isExternal()).toBe(true);
  });

  it('persists external=true through toJSON and rebuilds it via fromJSON', () => {
    const version = new FileVersion(['a'], 42, undefined, true);

    const json: SerializedFileVersion = version.toJSON();
    expect(json.external).toBe(true);

    const restored: FileVersion = FileVersion.fromJSON(json);
    expect(restored.isExternal()).toBe(true);
    expect(restored.external).toBe(true);
    expect(restored.getLines()).toEqual(['a']);
    expect(restored.timestamp).toBe(42);
  });

  it('omits the external field for a non-external version', () => {
    const version = new FileVersion(['a'], 1);

    const json: SerializedFileVersion = version.toJSON();
    expect(json).not.toHaveProperty('external');

    const restored: FileVersion = FileVersion.fromJSON(json);
    expect(restored.external).toBeUndefined();
    expect(restored.isExternal()).toBe(false);
  });

  it('keeps external and label independent on the same version', () => {
    const version = new FileVersion(['a'], 5, 'pin', true);

    expect(version.isLabeled()).toBe(true);
    expect(version.isExternal()).toBe(true);
    expect(version.label).toBe('pin');
    expect(version.external).toBe(true);

    const json: SerializedFileVersion = version.toJSON();
    expect(json.label).toBe('pin');
    expect(json.external).toBe(true);

    const restored: FileVersion = FileVersion.fromJSON(json);
    expect(restored.isLabeled()).toBe(true);
    expect(restored.isExternal()).toBe(true);
    expect(restored.label).toBe('pin');
    expect(restored.external).toBe(true);
  });

  it('treats external=false as not external (no field in JSON)', () => {
    const version = new FileVersion(['a'], 1, undefined, false);

    expect(version.external).toBeUndefined();
    expect(version.isExternal()).toBe(false);
    expect(version.toJSON()).not.toHaveProperty('external');
  });
});

describe('FileSnapshot.evictVersions: labeled versions are pinned', () => {
  const DAY: number = 24 * 60 * 60 * 1000;

  it('keeps a labeled version older than maxVersionAgeDays while dropping unlabeled stale entries', () => {
    const base: number = 10_000_000_000;
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(base);

    const snapshot = new FileSnapshot('a', '\n');
    const opts = options({ editThreshold: 1, maxVersionAgeDays: 14 });

    // Two stale entries 30 days in the past: one labeled (pinned), one not.
    nowSpy.mockReturnValue(base - (30 * DAY));
    snapshot.captureVersion(['old-unlabeled'], opts);
    snapshot.captureVersion(['old-labeled'], opts, false, 'keep-me');

    // A fresh capture at the present time runs eviction.
    nowSpy.mockReturnValue(base);
    snapshot.captureVersion(['fresh'], opts);

    // The unlabeled stale entry is evicted; the labeled stale one survives.
    const surviving: string[][] = snapshot.getVersions().map((v: FileVersion): string[] => v.getLines());
    expect(surviving).toEqual([['fresh'], ['old-labeled']]);
    expect(snapshot.getVersions()[1].isLabeled()).toBe(true);
  });

  it('keeps labeled versions beyond the maxVersions count cap', () => {
    const snapshot = new FileSnapshot('a', '\n');
    const opts = options({ editThreshold: 1, maxVersions: 2 });

    // Insert one labeled version followed by four unlabeled ones. The count cap
    // applies to unlabeled entries only: the labeled marker must survive even
    // though it is the oldest entry on the timeline.
    snapshot.captureVersion(['labeled'], opts, false, 'keep-me');
    snapshot.captureVersion(['u1'], opts);
    snapshot.captureVersion(['u2'], opts);
    snapshot.captureVersion(['u3'], opts);
    snapshot.captureVersion(['u4'], opts);

    const lines: string[][] = snapshot.getVersions().map((v: FileVersion): string[] => v.getLines());
    // Newest first: two unlabeled (cap = 2) plus the pinned labeled marker.
    expect(lines).toEqual([['u4'], ['u3'], ['labeled']]);
    expect(snapshot.getVersions()[2].isLabeled()).toBe(true);
  });
});
