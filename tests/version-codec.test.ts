import { describe, expect, it } from '@jest/globals';

import { VERSION_KEYFRAME_INTERVAL } from '@/consts';
import { FileVersion } from '@/snapshots/file.version';
import { VersionCodec } from '@/snapshots/version-codec';
import type { SerializedFileVersion } from '@/types';

/**
 * Tests for VersionCodec.encode (Epic 09, T02): the materialized FileVersion[]
 * is turned into a keyframe + delta entry chain with the correct per-index
 * cadence, flags are preserved on either form, and a delta is actually smaller
 * than the full joined text it replaces. Decode is covered separately (T03).
 */

const makeVersions = (count: number, mutate?: (i: number) => Partial<{ label: string; external: boolean }>): FileVersion[] => {
  const versions: FileVersion[] = [];

  for (let i: number = 0; i < count; i++) {
    const extras = mutate?.(i) ?? {};

    versions.push(new FileVersion([`line-a-${i}`, `line-b-${i}`, `line-c-${i}`], 1000 + i, extras.label, extras.external));
  }

  return versions;
};

describe('VersionCodec.encode', (): void => {
  it('returns an empty array for empty input', (): void => {
    expect(VersionCodec.encode([], '\n')).toEqual([]);
  });

  it('emits index 0 as a keyframe carrying the version exact lines', (): void => {
    const version: FileVersion = new FileVersion(['alpha', 'beta'], 42);

    const entries: SerializedFileVersion[] = VersionCodec.encode([version], '\n');

    expect(entries).toHaveLength(1);
    expect(entries[0].timestamp).toBe(42);
    expect(entries[0].lines).toEqual(['alpha', 'beta']);
    expect(entries[0].delta).toBeUndefined();
  });

  it('keyframes at index 0 and at the interval, deltas everywhere else', (): void => {
    const versions: FileVersion[] = makeVersions(VERSION_KEYFRAME_INTERVAL + 1);

    const entries: SerializedFileVersion[] = VersionCodec.encode(versions, '\n');

    expect(entries).toHaveLength(VERSION_KEYFRAME_INTERVAL + 1);

    entries.forEach((entry: SerializedFileVersion, i: number): void => {
      if (i % VERSION_KEYFRAME_INTERVAL === 0) {
        expect(entry.lines).toBeDefined();
        expect(entry.delta).toBeUndefined();
      } else {
        expect(entry.lines).toBeUndefined();
        expect(typeof entry.delta).toBe('string');
        expect(entry.delta!.length).toBeGreaterThan(0);
      }
    });

    expect(entries[0].lines).toBeDefined();
    expect(entries[VERSION_KEYFRAME_INTERVAL].lines).toBeDefined();
  });

  it('preserves label and external on a keyframe entry', (): void => {
    const version: FileVersion = new FileVersion(['x'], 7, 'pinned', true);

    const entries: SerializedFileVersion[] = VersionCodec.encode([version], '\n');

    expect(entries[0].lines).toBeDefined();
    expect(entries[0].label).toBe('pinned');
    expect(entries[0].external).toBe(true);
  });

  it('preserves label and external on a delta entry', (): void => {
    const versions: FileVersion[] = makeVersions(2, (i: number) => (i === 1 ? { label: 'tag', external: true } : {}));

    const entries: SerializedFileVersion[] = VersionCodec.encode(versions, '\n');

    expect(entries[1].delta).toBeDefined();
    expect(entries[1].lines).toBeUndefined();
    expect(entries[1].label).toBe('tag');
    expect(entries[1].external).toBe(true);
  });

  it('omits label and external when the source version does not carry them', (): void => {
    const versions: FileVersion[] = makeVersions(2);

    const entries: SerializedFileVersion[] = VersionCodec.encode(versions, '\n');

    entries.forEach((entry: SerializedFileVersion): void => {
      expect('label' in entry).toBe(false);
      expect('external' in entry).toBe(false);
    });
  });

  it('produces a delta shorter than the full joined text when versions differ by one line', (): void => {
    const base: string[] = Array.from({ length: 200 }, (_unused: unknown, i: number): string => `content-line-number-${i}-with-padding`);
    const changed: string[] = [...base];
    changed[100] = 'content-line-number-100-CHANGED';

    const first: FileVersion = new FileVersion(base, 1);
    const second: FileVersion = new FileVersion(changed, 2);

    const entries: SerializedFileVersion[] = VersionCodec.encode([first, second], '\n');

    const fullText: string = second.getLines().join('\n');

    expect(entries[1].delta).toBeDefined();
    expect(entries[1].delta!.length).toBeLessThan(fullText.length);
  });

  it('does not mutate the input versions array or any FileVersion', (): void => {
    const versions: FileVersion[] = makeVersions(3);
    const snapshot: string[][] = versions.map((v: FileVersion): string[] => v.getLines());
    const length: number = versions.length;

    VersionCodec.encode(versions, '\n');

    expect(versions).toHaveLength(length);
    versions.forEach((v: FileVersion, i: number): void => {
      expect(v.getLines()).toEqual(snapshot[i]);
    });
  });
});
