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

/**
 * Tests for VersionCodec.decode (Epic 09, T03): the keyframe + delta entry chain
 * is rebuilt into a materialized FileVersion[], preserving timestamp/label/
 * external, decoding old all-keyframe (version-1) files natively, and skipping
 * unanchored or unappliable deltas without throwing (ADR-08-B resilience).
 */
describe('VersionCodec.decode', (): void => {
  it('returns an empty array for empty input', (): void => {
    expect(VersionCodec.decode([], '\n')).toEqual([]);
  });

  it('returns an empty array for a non-array input', (): void => {
    expect(VersionCodec.decode(null as unknown as SerializedFileVersion[], '\n')).toEqual([]);
  });

  it('round-trips an encoded chain back to the original lines', (): void => {
    const versions: FileVersion[] = makeVersions(VERSION_KEYFRAME_INTERVAL + 5);

    const decoded: FileVersion[] = VersionCodec.decode(VersionCodec.encode(versions, '\n'), '\n');

    expect(decoded).toHaveLength(versions.length);
    decoded.forEach((version: FileVersion, i: number): void => {
      expect(version.getLines()).toEqual(versions[i].getLines());
    });
  });

  it('preserves timestamp, label and external across the round-trip', (): void => {
    const versions: FileVersion[] = makeVersions(2, (i: number) => (i === 1 ? { label: 'tag', external: true } : {}));

    const decoded: FileVersion[] = VersionCodec.decode(VersionCodec.encode(versions, '\n'), '\n');

    expect(decoded[0].timestamp).toBe(1000);
    expect(decoded[0].isLabeled()).toBe(false);
    expect(decoded[0].isExternal()).toBe(false);
    expect(decoded[1].timestamp).toBe(1001);
    expect(decoded[1].label).toBe('tag');
    expect(decoded[1].isExternal()).toBe(true);
  });

  it('decodes an all-keyframe version-1 entry array natively', (): void => {
    const entries: SerializedFileVersion[] = [
      { timestamp: 1, lines: ['a', 'b'] },
      { timestamp: 2, lines: ['c', 'd'], label: 'pinned' },
      { timestamp: 3, lines: ['e'], external: true },
    ];

    const decoded: FileVersion[] = VersionCodec.decode(entries, '\n');

    expect(decoded).toHaveLength(3);
    expect(decoded[0].getLines()).toEqual(['a', 'b']);
    expect(decoded[1].getLines()).toEqual(['c', 'd']);
    expect(decoded[1].label).toBe('pinned');
    expect(decoded[2].getLines()).toEqual(['e']);
    expect(decoded[2].isExternal()).toBe(true);
  });

  it('preserves a CRLF-derived line set across the round-trip', (): void => {
    const versions: FileVersion[] = [
      new FileVersion(['first\r', 'second\r', 'third'], 1),
      new FileVersion(['first\r', 'second-changed\r', 'third'], 2),
    ];

    const decoded: FileVersion[] = VersionCodec.decode(VersionCodec.encode(versions, '\r\n'), '\r\n');

    expect(decoded[0].getLines()).toEqual(['first\r', 'second\r', 'third']);
    expect(decoded[1].getLines()).toEqual(['first\r', 'second-changed\r', 'third']);
  });

  it('drops a corrupted delta segment and resyncs at the next keyframe', (): void => {
    // Corrupting one delta bounds its blast radius to the segment up to the next
    // keyframe: deltas chain off the prior materialized state, so the entries
    // between the break and the next keyframe are dropped, then the keyframe and
    // everything after it materialize correctly (the resync guarantee).
    const versions: FileVersion[] = makeVersions(VERSION_KEYFRAME_INTERVAL + 2);
    const entries: SerializedFileVersion[] = VersionCodec.encode(versions, '\n');

    expect(entries[1].delta).toBeDefined();
    entries[1].delta = '@@ this is not a valid patch @@\n-nonexistent-line\n';

    const decoded: FileVersion[] = VersionCodec.decode(entries, '\n');

    // Survivors: keyframe 0, then keyframe VERSION_KEYFRAME_INTERVAL and its
    // following delta. The corrupt segment (indices 1..interval-1) is dropped.
    expect(decoded).toHaveLength(3);
    expect(decoded[0].getLines()).toEqual(versions[0].getLines());
    expect(decoded[1].getLines()).toEqual(versions[VERSION_KEYFRAME_INTERVAL].getLines());
    expect(decoded[2].getLines()).toEqual(versions[VERSION_KEYFRAME_INTERVAL + 1].getLines());
  });

  it('drops only the single corrupted version when a keyframe follows immediately', (): void => {
    // When the next entry after the corrupt delta is a keyframe, the resync is
    // immediate and exactly one version is lost.
    const versions: FileVersion[] = makeVersions(VERSION_KEYFRAME_INTERVAL + 2);
    const entries: SerializedFileVersion[] = VersionCodec.encode(versions, '\n');

    const corruptIndex: number = VERSION_KEYFRAME_INTERVAL - 1;
    expect(entries[corruptIndex].delta).toBeDefined();
    entries[corruptIndex].delta = '@@ broken @@\n-nope\n';

    const decoded: FileVersion[] = VersionCodec.decode(entries, '\n');

    // Only the corrupted version is lost; the keyframe at the interval resyncs.
    expect(decoded).toHaveLength(versions.length - 1);
    expect(decoded[decoded.length - 1].getLines()).toEqual(versions[versions.length - 1].getLines());
    expect(decoded[VERSION_KEYFRAME_INTERVAL - 1].getLines()).toEqual(versions[VERSION_KEYFRAME_INTERVAL].getLines());
  });

  it('skips a delta that appears before any keyframe without throwing', (): void => {
    const entries: SerializedFileVersion[] = [
      { timestamp: 1, delta: '@@ -1 +1 @@\n-old\n+new\n' },
      { timestamp: 2, lines: ['anchor'] },
    ];

    let decoded: FileVersion[] = [];

    expect((): void => {
      decoded = VersionCodec.decode(entries, '\n');
    }).not.toThrow();

    expect(decoded).toHaveLength(1);
    expect(decoded[0].getLines()).toEqual(['anchor']);
  });

  it('skips null and non-object entries defensively', (): void => {
    const entries: SerializedFileVersion[] = [
      null as unknown as SerializedFileVersion,
      { timestamp: 1, lines: ['kept'] },
    ];

    const decoded: FileVersion[] = VersionCodec.decode(entries, '\n');

    expect(decoded).toHaveLength(1);
    expect(decoded[0].getLines()).toEqual(['kept']);
  });
});

/**
 * Round-trip, superset and edge property tests (Epic 09, T04). These prove
 * `encode` -> `decode` is lossless across the cases the real serialization path
 * (T05) leans on: chains that span several keyframe intervals (so multiple
 * keyframes are exercised, not just index 0 and the first interval), CRLF
 * content, label/external flags, empty and trailing-blank lines, and a
 * hand-built old-format (all-keyframe, version-1) array decoding unchanged.
 * Versions are built from real `FileVersion` instances so the round-trip runs
 * the genuine `lines` plumbing, and structural facts (keyframe cadence) are
 * asserted alongside content so a cadence regression is caught too.
 */
describe('VersionCodec round-trip and edges (T04)', (): void => {
  it('round-trips a chain spanning multiple keyframe intervals with keyframes at every multiple', (): void => {
    // 2.5 intervals worth of versions, so the chain holds keyframes at 0, the
    // interval and twice the interval, plus a trailing partial delta run.
    const count: number = VERSION_KEYFRAME_INTERVAL * 2 + Math.floor(VERSION_KEYFRAME_INTERVAL / 2);
    const versions: FileVersion[] = makeVersions(count);

    const entries: SerializedFileVersion[] = VersionCodec.encode(versions, '\n');
    const decoded: FileVersion[] = VersionCodec.decode(entries, '\n');

    expect(entries).toHaveLength(count);
    expect(decoded).toHaveLength(count);

    entries.forEach((entry: SerializedFileVersion, i: number): void => {
      if (i % VERSION_KEYFRAME_INTERVAL === 0) {
        expect(entry.lines).toBeDefined();
        expect(entry.delta).toBeUndefined();
      } else {
        expect(entry.lines).toBeUndefined();
        expect(typeof entry.delta).toBe('string');
      }
    });

    // At least three keyframes are exercised, proving multi-keyframe coverage.
    const keyframeCount: number = entries.filter((entry: SerializedFileVersion): boolean => entry.lines !== undefined).length;
    expect(keyframeCount).toBe(Math.floor((count - 1) / VERSION_KEYFRAME_INTERVAL) + 1);
    expect(keyframeCount).toBeGreaterThanOrEqual(3);

    decoded.forEach((version: FileVersion, i: number): void => {
      expect(version.getLines()).toEqual(versions[i].getLines());
      expect(version.timestamp).toBe(versions[i].timestamp);
    });
  });

  it('round-trips CRLF-derived versions across a multi-version chain without \\r corruption', (): void => {
    // Lines carry a trailing \r because they were split from CRLF content on the
    // \r\n line break; the \n transport must leave that \r untouched.
    const versions: FileVersion[] = [
      new FileVersion(['alpha\r', 'beta\r', 'gamma'], 1),
      new FileVersion(['alpha\r', 'beta-edited\r', 'gamma'], 2),
      new FileVersion(['alpha\r', 'beta-edited\r', 'gamma', 'delta\r'], 3),
    ];

    const decoded: FileVersion[] = VersionCodec.decode(VersionCodec.encode(versions, '\r\n'), '\r\n');

    expect(decoded).toHaveLength(versions.length);
    decoded.forEach((version: FileVersion, i: number): void => {
      expect(version.getLines()).toEqual(versions[i].getLines());
    });
  });

  it('round-trips label and external flags on both keyframe and delta forms', (): void => {
    // Flags on index 0 (a keyframe) and on a later delta entry both survive.
    const versions: FileVersion[] = [
      new FileVersion(['root'], 1, 'pinned-root', true),
      new FileVersion(['root', 'next'], 2),
      new FileVersion(['root', 'next', 'leaf'], 3, 'pinned-leaf', true),
    ];

    const decoded: FileVersion[] = VersionCodec.decode(VersionCodec.encode(versions, '\n'), '\n');

    expect(decoded[0].label).toBe('pinned-root');
    expect(decoded[0].isExternal()).toBe(true);
    expect(decoded[1].isLabeled()).toBe(false);
    expect(decoded[1].isExternal()).toBe(false);
    expect(decoded[2].label).toBe('pinned-leaf');
    expect(decoded[2].isExternal()).toBe(true);
  });

  it('round-trips content with empty lines and trailing blank lines exactly', (): void => {
    // Blank and trailing-empty lines stress the patch transport: an off-by-one in
    // join/split would drop a terminal blank or merge two empties.
    const versions: FileVersion[] = [
      new FileVersion(['head', '', 'body', '', ''], 1),
      new FileVersion(['head', '', 'body-changed', '', '', ''], 2),
      new FileVersion(['', '', 'only-trailing', ''], 3),
    ];

    const decoded: FileVersion[] = VersionCodec.decode(VersionCodec.encode(versions, '\n'), '\n');

    expect(decoded).toHaveLength(versions.length);
    decoded.forEach((version: FileVersion, i: number): void => {
      expect(version.getLines()).toEqual(versions[i].getLines());
      expect(version.getLines()).toHaveLength(versions[i].getLines().length);
    });
  });

  it('decodes a hand-built all-keyframe version-1 array with no delta handling', (): void => {
    // The version-1 on-disk shape is every entry full-text; decode must treat
    // each as a keyframe natively (the superset property) with no delta in sight.
    const entries: SerializedFileVersion[] = [
      { timestamp: 10, lines: ['one', 'two'] },
      { timestamp: 20, lines: ['one', 'two', 'three'], label: 'kept' },
      { timestamp: 30, lines: ['one'], external: true },
      { timestamp: 40, lines: ['', 'trailing', ''] },
    ];

    entries.forEach((entry: SerializedFileVersion): void => {
      expect(entry.delta).toBeUndefined();
    });

    const decoded: FileVersion[] = VersionCodec.decode(entries, '\n');

    expect(decoded).toHaveLength(4);
    expect(decoded[0].getLines()).toEqual(['one', 'two']);
    expect(decoded[1].getLines()).toEqual(['one', 'two', 'three']);
    expect(decoded[1].label).toBe('kept');
    expect(decoded[2].getLines()).toEqual(['one']);
    expect(decoded[2].isExternal()).toBe(true);
    expect(decoded[3].getLines()).toEqual(['', 'trailing', '']);
  });
});
