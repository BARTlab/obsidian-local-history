import { describe, expect, it } from 'vitest';

import { KeepHistory } from '@/consts';
import * as OriginHelper from '@/helpers/origin.helper';
import { FileSnapshot } from '@/snapshots/file.snapshot';
import { FileVersion } from '@/snapshots/file.version';

import { makeFile } from './helpers/builders';

/**
 * A snapshot whose marker baseline, history baseline, and timeline hold three
 * distinct contents, so each resolveOrigin branch is unambiguous. The marker
 * baseline comes from construction; adoptHistory overrides only the history
 * baseline and the timeline, leaving the marker baseline untouched.
 */
const makeSnapshot = (versions: FileVersion[]): FileSnapshot => {
  const snapshot: FileSnapshot = new FileSnapshot('marker', '\n', makeFile('a.md'));
  snapshot.adoptHistory(['history'], versions);

  return snapshot;
};

describe('OriginHelper.resolveOrigin', () => {
  it('returns the marker baseline for keep=file regardless of versions', () => {
    const snapshot: FileSnapshot = makeSnapshot([new FileVersion(['oldest']), new FileVersion(['newest'])]);

    expect(OriginHelper.resolveOrigin(snapshot, KeepHistory.file)).toEqual(['marker']);
  });

  it('returns the marker baseline for keep=app regardless of versions', () => {
    const snapshot: FileSnapshot = makeSnapshot([new FileVersion(['oldest']), new FileVersion(['newest'])]);

    expect(OriginHelper.resolveOrigin(snapshot, KeepHistory.app)).toEqual(['marker']);
  });

  it('returns the oldest version lines for keep=persist with a non-empty timeline', () => {
    const snapshot: FileSnapshot = makeSnapshot([new FileVersion(['oldest']), new FileVersion(['newest'])]);

    expect(OriginHelper.resolveOrigin(snapshot, KeepHistory.persist)).toEqual(['oldest']);
  });

  it('falls back to the history baseline for keep=persist with an empty timeline', () => {
    const snapshot: FileSnapshot = makeSnapshot([]);

    expect(OriginHelper.resolveOrigin(snapshot, KeepHistory.persist)).toEqual(['history']);
  });

  it('resolves a pinned oldest version as the origin at keep=persist (approximate bound)', () => {
    const snapshot: FileSnapshot = makeSnapshot([
      new FileVersion(['pinned'], undefined, 'milestone'),
      new FileVersion(['newest']),
    ]);

    expect(OriginHelper.resolveOrigin(snapshot, KeepHistory.persist)).toEqual(['pinned']);
  });

  it('returns a fresh array callers cannot use to mutate snapshot state', () => {
    const snapshot: FileSnapshot = makeSnapshot([new FileVersion(['oldest'])]);

    const resolved: string[] = OriginHelper.resolveOrigin(snapshot, KeepHistory.persist);
    resolved.push('mutated');

    expect(OriginHelper.resolveOrigin(snapshot, KeepHistory.persist)).toEqual(['oldest']);
  });

  it('never throws on a bare snapshot with no versions', () => {
    const snapshot: FileSnapshot = new FileSnapshot('only', '\n', makeFile('b.md'));

    expect(() => OriginHelper.resolveOrigin(snapshot, KeepHistory.persist)).not.toThrow();
    expect(OriginHelper.resolveOrigin(snapshot, KeepHistory.persist)).toEqual(['only']);
  });
});
