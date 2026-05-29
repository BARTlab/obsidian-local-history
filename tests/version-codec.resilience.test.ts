import { describe, expect, it } from '@jest/globals';

import { VERSION_KEYFRAME_INTERVAL } from '@/consts';
import { FileVersion } from '@/snapshots/file.version';
import { VersionCodec } from '@/snapshots/version-codec';
import type { SerializedFileVersion } from '@/types';

/**
 * Corruption-resilience tests for VersionCodec.decode (Epic 09, T08). These pin
 * the ADR-08-B guarantee that a damaged on-disk delta chain degrades the
 * timeline instead of crashing plugin load. Each case constructs the corruption
 * explicitly (mutating `delta` strings or reordering entries), never via random
 * fuzzing, so a failure is deterministic and debuggable. Every case asserts both
 * the no-throw property and, where a keyframe follows, the resync property: a
 * post-keyframe version still materializes correctly.
 *
 * Decode is tests-only here; the resilience behaviour itself lives in T03's
 * source and must not be re-implemented or modified from this file.
 */

const makeVersions = (count: number): FileVersion[] => {
  const versions: FileVersion[] = [];

  // Distinct, multi-line content per version so each delta is a real patch with
  // a non-empty hunk body that can be meaningfully truncated.
  for (let i: number = 0; i < count; i++) {
    versions.push(new FileVersion([`alpha-${i}`, `beta-${i}`, `gamma-${i}`, 'shared-tail'], 1000 + i));
  }

  return versions;
};

const decodeWithoutThrowing = (entries: SerializedFileVersion[]): FileVersion[] => {
  let decoded: FileVersion[] = [];

  expect((): void => {
    decoded = VersionCodec.decode(entries, '\n');
  }).not.toThrow();

  return decoded;
};

describe('VersionCodec.decode resilience (T08)', (): void => {
  it('drops only the truncated version and resyncs at the very next keyframe', (): void => {
    // The entry right before the interval keyframe is a delta; truncating its
    // hunk body (cutting just after the `@@` header) makes applyPatch reject the
    // patch (the announced line count no longer matches the body), which decode
    // catches. Exactly that one version is dropped and the keyframe at the
    // interval resyncs the chain immediately, losing nothing after it.
    const versions: FileVersion[] = makeVersions(VERSION_KEYFRAME_INTERVAL + 2);
    const entries: SerializedFileVersion[] = VersionCodec.encode(versions, '\n');

    const corruptIndex: number = VERSION_KEYFRAME_INTERVAL - 1;
    const original: string | undefined = entries[corruptIndex].delta;
    expect(typeof original).toBe('string');

    const hunkHeaderEnd: number = original!.indexOf('\n', original!.indexOf('@@ -'));
    expect(hunkHeaderEnd).toBeGreaterThan(-1);
    // Keep everything up to and including the `@@` header line plus a single
    // character of the body, so the hunk is announced but its content is cut off.
    entries[corruptIndex].delta = original!.slice(0, hunkHeaderEnd + 2);

    const decoded: FileVersion[] = decodeWithoutThrowing(entries);

    // Every version survives except the single truncated one.
    expect(decoded).toHaveLength(versions.length - 1);
    // Resync: the interval keyframe and everything after it are intact.
    expect(decoded[VERSION_KEYFRAME_INTERVAL - 1].getLines()).toEqual(versions[VERSION_KEYFRAME_INTERVAL].getLines());
    expect(decoded[decoded.length - 1].getLines()).toEqual(versions[versions.length - 1].getLines());
  });

  it('does not throw when a delta hunk body is removed (parse error caught)', (): void => {
    // Stripping an addition line from the hunk leaves the `@@` line-count header
    // inconsistent with the body, which makes applyPatch throw; decode must catch
    // it, skip the version, and keep going rather than crash load.
    const versions: FileVersion[] = makeVersions(3);
    const entries: SerializedFileVersion[] = VersionCodec.encode(versions, '\n');

    const original: string | undefined = entries[1].delta;
    expect(typeof original).toBe('string');
    // Remove every `+` addition line, leaving the deletions and the header count
    // claiming additions that are no longer present.
    entries[1].delta = original!
      .split('\n')
      .filter((line: string): boolean => !/^\+/.test(line))
      .join('\n');

    const decoded: FileVersion[] = decodeWithoutThrowing(entries);

    // The keyframe at 0 survives; the broken delta at 1 is dropped. Version 2 is
    // itself a delta chained off the dropped version, so it cannot resync without
    // a keyframe and is dropped too (segment-level loss, per FINDINGS T03).
    expect(decoded).toHaveLength(1);
    expect(decoded[0].getLines()).toEqual(versions[0].getLines());
  });

  it('drops a delta whose context no longer matches its predecessor (applyPatch returns false) and resyncs', (): void => {
    // A syntactically valid, line-count-consistent patch whose deletion line does
    // not match the materialized predecessor: applyPatch returns false (not a
    // throw), so this exercises the false branch of materialize. The trailing
    // keyframe then resyncs and its delta decodes correctly.
    const entries: SerializedFileVersion[] = [
      { timestamp: 1, lines: ['anchor', 'body'] },
      // Deletes 'WRONG' which is not line 1 of the predecessor -> false.
      { timestamp: 2, delta: '@@ -1,1 +1,1 @@\n-WRONG\n+changed\n' },
      { timestamp: 3, lines: ['resync', 'tail'] },
      { timestamp: 4, delta: '@@ -2,1 +2,1 @@\n-tail\n+tail-edited\n' },
    ];

    const decoded: FileVersion[] = decodeWithoutThrowing(entries);

    // The mismatched delta at index 1 is dropped; the rest survive.
    expect(decoded).toHaveLength(3);
    expect(decoded[0].getLines()).toEqual(['anchor', 'body']);
    expect(decoded[1].timestamp).toBe(3);
    expect(decoded[1].getLines()).toEqual(['resync', 'tail']);
    expect(decoded[2].timestamp).toBe(4);
    expect(decoded[2].getLines()).toEqual(['resync', 'tail-edited']);
  });

  it('skips a delta entry placed before the first keyframe and decodes the rest', (): void => {
    // An entry array that opens with a delta (no keyframe has anchored `prev`):
    // the unanchored delta is skipped and the following keyframe and its delta
    // decode normally, all without throwing.
    const entries: SerializedFileVersion[] = [
      { timestamp: 1, delta: '@@ -1 +1 @@\n-stale\n+fresh\n' },
      { timestamp: 2, lines: ['anchor', 'body'] },
      { timestamp: 3, delta: '@@ -2,1 +2,1 @@\n-body\n+body-edited\n' },
    ];

    const decoded: FileVersion[] = decodeWithoutThrowing(entries);

    expect(decoded).toHaveLength(2);
    expect(decoded[0].timestamp).toBe(2);
    expect(decoded[0].getLines()).toEqual(['anchor', 'body']);
    expect(decoded[1].timestamp).toBe(3);
    expect(decoded[1].getLines()).toEqual(['anchor', 'body-edited']);
  });

  it('resyncs across a keyframe boundary when a corrupt run precedes it', (): void => {
    // Corrupt several consecutive deltas inside the first segment: the whole run
    // up to the interval keyframe is dropped, then the keyframe and the deltas
    // after it materialize correctly (the resync guarantee across a boundary).
    const versions: FileVersion[] = makeVersions(VERSION_KEYFRAME_INTERVAL + 3);
    const entries: SerializedFileVersion[] = VersionCodec.encode(versions, '\n');

    for (let i: number = 2; i <= 4; i++) {
      expect(typeof entries[i].delta).toBe('string');
      entries[i].delta = '@@ corrupt @@\n-gone\n';
    }

    const decoded: FileVersion[] = decodeWithoutThrowing(entries);

    // Survivors before the keyframe: indices 0 and 1 only (the chain breaks at the
    // first corrupt delta and cannot resync until the keyframe).
    expect(decoded[0].getLines()).toEqual(versions[0].getLines());
    expect(decoded[1].getLines()).toEqual(versions[1].getLines());
    // From the interval keyframe onward, every version is intact again.
    const keyframeVersion: FileVersion = decoded[decoded.length - 3];
    expect(keyframeVersion.getLines()).toEqual(versions[VERSION_KEYFRAME_INTERVAL].getLines());
    expect(decoded[decoded.length - 1].getLines()).toEqual(versions[versions.length - 1].getLines());
  });

  it('returns a possibly-empty array without throwing when no usable keyframe survives', (): void => {
    // A fully corrupt chain: index 0 is a delta (so nothing anchors it) and every
    // later entry is garbage. Decode must yield an empty array, never throw.
    const entries: SerializedFileVersion[] = [
      { timestamp: 1, delta: '@@ -1 +1 @@\n-a\n+b\n' },
      { timestamp: 2, delta: '@@ not a patch @@\n-x\n' },
      { timestamp: 3, delta: 'totally-unparseable-garbage' },
    ];

    const decoded: FileVersion[] = decodeWithoutThrowing(entries);

    expect(decoded).toEqual([]);
  });

  it('keeps the surviving prefix when corruption with no later keyframe ends the chain', (): void => {
    // Corruption inside the only segment with no trailing keyframe: the prefix up
    // to the break survives, the rest is lost, and decode does not throw.
    const versions: FileVersion[] = makeVersions(4);
    const entries: SerializedFileVersion[] = VersionCodec.encode(versions, '\n');

    expect(typeof entries[2].delta).toBe('string');
    entries[2].delta = '@@ broken @@\n-nope\n';

    const decoded: FileVersion[] = decodeWithoutThrowing(entries);

    // Versions 0 and 1 survive; 2 (corrupt) and 3 (chained off 2) are lost.
    expect(decoded).toHaveLength(2);
    expect(decoded[0].getLines()).toEqual(versions[0].getLines());
    expect(decoded[1].getLines()).toEqual(versions[1].getLines());
  });
});
