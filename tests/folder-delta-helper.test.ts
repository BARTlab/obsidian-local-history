import 'reflect-metadata';
import { describe, expect, it } from '@jest/globals';

import { FolderDeltaHelper } from '@/helpers/folder-delta.helper';
import type { FolderDeltaResult } from '@/types';
import { FileSnapshot } from '@/snapshots/file.snapshot';
import { FileVersion } from '@/snapshots/file.version';
import type { TFile } from 'obsidian';

/**
 * Builds a minimal `TFile`-like object that satisfies the snapshot's path
 * accessor without dragging in Obsidian's full type.
 */
const makeFile = (path: string): TFile => {
  const name: string = path.split('/').pop() ?? path;
  const extension: string = name.includes('.') ? name.split('.').pop() ?? '' : '';

  return { path, name, extension } as unknown as TFile;
};

/**
 * Builds a live snapshot whose creation timestamp, history baseline, version
 * timeline, and current `state` are all explicit so the AC grid can be pinned
 * without depending on Date.now() or capture cadence side-effects.
 */
const makeLiveSnapshot = (params: {
  path: string;
  createdAt: number;
  historyLines?: string[];
  versions?: Array<{ timestamp: number; lines: string[] }>;
  state?: string[];
}): FileSnapshot => {
  const history: string[] = params.historyLines ?? ['baseline'];
  const snapshot: FileSnapshot = new FileSnapshot(history.join('\n'), '\n', makeFile(params.path));

  snapshot.timestamp = params.createdAt;
  snapshot.historyLines = [...history];
  snapshot.versions = (params.versions ?? []).map(
    (entry: { timestamp: number; lines: string[] }): FileVersion => new FileVersion(entry.lines, entry.timestamp),
  );
  snapshot.updateState(params.state ?? history);

  return snapshot;
};

/**
 * Builds a tombstone snapshot at `path` mirroring what `SnapshotsService.markDeleted`
 * leaves in the map: same history baseline and version timeline as before the
 * delete, `deletedTimestamp` set, current state cleared in the same way the
 * service clears session-only parts.
 */
const makeTombstone = (params: {
  path: string;
  createdAt: number;
  deletedAt: number;
  historyLines?: string[];
  versions?: Array<{ timestamp: number; lines: string[] }>;
  finalState?: string[];
}): FileSnapshot => {
  const snapshot: FileSnapshot = makeLiveSnapshot({
    path: params.path,
    createdAt: params.createdAt,
    historyLines: params.historyLines,
    versions: params.versions,
    state: params.finalState ?? params.historyLines,
  });

  snapshot.deletedTimestamp = params.deletedAt;

  return snapshot;
};

describe('FolderDeltaHelper.compareAt - defensive inputs', () => {
  it('returns none-with-empty-content for a missing snapshot', () => {
    const result: FolderDeltaResult = FolderDeltaHelper.compareAt(undefined, 1_000);

    expect(result.status).toBe('none');
    expect(result.base).toEqual([]);
    expect(result.current).toEqual([]);
  });
});

describe('FolderDeltaHelper.compareAt - live snapshot, base resolution', () => {
  it('returns the latest version whose timestamp is at or before T as the base', () => {
    // Versions v1@t1, v2@t2, T between t1 and t2 -> base = v1 (AC1).
    const snapshot: FileSnapshot = makeLiveSnapshot({
      path: 'root/a.md',
      createdAt: 500,
      historyLines: ['baseline'],
      versions: [
        { timestamp: 1_000, lines: ['v1 line'] },
        { timestamp: 3_000, lines: ['v2 line'] },
      ],
      state: ['current line'],
    });

    const result: FolderDeltaResult = FolderDeltaHelper.compareAt(snapshot, 2_000);

    expect(result.status).toBe('modified');
    expect(result.base).toEqual(['v1 line']);
    expect(result.current).toEqual(['current line']);
  });

  it('falls back to the history baseline when T precedes every captured version', () => {
    // AC2: T < t1 -> base = history baseline.
    const snapshot: FileSnapshot = makeLiveSnapshot({
      path: 'root/a.md',
      createdAt: 500,
      historyLines: ['baseline content'],
      versions: [
        { timestamp: 2_000, lines: ['v1'] },
        { timestamp: 3_000, lines: ['v2'] },
      ],
      state: ['current'],
    });

    const result: FolderDeltaResult = FolderDeltaHelper.compareAt(snapshot, 1_000);

    expect(result.status).toBe('modified');
    expect(result.base).toEqual(['baseline content']);
    expect(result.current).toEqual(['current']);
  });

  it('picks the version captured exactly at T as the inclusive boundary', () => {
    // The contract says "latest version whose timestamp <= T": when a version
    // sits exactly at T, it is the resolved base (not the next-older one).
    const snapshot: FileSnapshot = makeLiveSnapshot({
      path: 'root/a.md',
      createdAt: 500,
      historyLines: ['baseline'],
      versions: [
        { timestamp: 1_000, lines: ['v1'] },
        { timestamp: 2_000, lines: ['v2 at T'] },
      ],
      state: ['current'],
    });

    const result: FolderDeltaResult = FolderDeltaHelper.compareAt(snapshot, 2_000);

    expect(result.base).toEqual(['v2 at T']);
  });
});

describe('FolderDeltaHelper.compareAt - existence at T', () => {
  it('reports added with an empty base when the snapshot was created after T', () => {
    // AC3: snapshot.timestamp > T -> the file did not exist at T -> status = 'added'.
    const snapshot: FileSnapshot = makeLiveSnapshot({
      path: 'root/a.md',
      createdAt: 5_000,
      historyLines: ['initial content'],
      versions: [],
      state: ['current'],
    });

    const result: FolderDeltaResult = FolderDeltaHelper.compareAt(snapshot, 1_000);

    expect(result.status).toBe('added');
    expect(result.base).toEqual([]);
    expect(result.current).toEqual(['current']);
  });

  it('does not consult any version captured after T when answering existence', () => {
    // A version captured after T must not retroactively make the file exist
    // at T: the snapshot's own creation timestamp is the existence boundary.
    const snapshot: FileSnapshot = makeLiveSnapshot({
      path: 'root/a.md',
      createdAt: 5_000,
      historyLines: ['initial'],
      versions: [{ timestamp: 6_000, lines: ['later version'] }],
      state: ['current'],
    });

    const result: FolderDeltaResult = FolderDeltaHelper.compareAt(snapshot, 1_000);

    expect(result.status).toBe('added');
    expect(result.base).toEqual([]);
  });
});

describe('FolderDeltaHelper.compareAt - tombstone snapshot', () => {
  it('returns deleted when the file existed at T and was deleted later', () => {
    // AC4: tombstone with deletedTimestamp > T -> existed at T, gone now.
    const tombstone: FileSnapshot = makeTombstone({
      path: 'root/a.md',
      createdAt: 500,
      deletedAt: 3_000,
      historyLines: ['baseline'],
      versions: [{ timestamp: 1_500, lines: ['v1 at delete-1.5'] }],
      finalState: ['final state'],
    });

    const result: FolderDeltaResult = FolderDeltaHelper.compareAt(tombstone, 2_000);

    expect(result.status).toBe('deleted');
    expect(result.base).toEqual(['v1 at delete-1.5']);
    expect(result.current).toEqual([]);
  });

  it('falls back to history baseline as the deleted-side base when T precedes every version', () => {
    // Same as AC2 but on a tombstone: a T that precedes every captured version
    // still resolves to the history baseline as the recoverable starting point.
    const tombstone: FileSnapshot = makeTombstone({
      path: 'root/a.md',
      createdAt: 500,
      deletedAt: 3_000,
      historyLines: ['baseline content'],
      versions: [{ timestamp: 2_000, lines: ['v1'] }],
      finalState: ['final state'],
    });

    const result: FolderDeltaResult = FolderDeltaHelper.compareAt(tombstone, 1_000);

    expect(result.status).toBe('deleted');
    expect(result.base).toEqual(['baseline content']);
    expect(result.current).toEqual([]);
  });

  it('returns none when the file was already deleted at or before T', () => {
    // AC5: deletedTimestamp <= T -> the tombstone was already gone at T, so
    // the folder tree should skip the row entirely.
    const tombstone: FileSnapshot = makeTombstone({
      path: 'root/a.md',
      createdAt: 500,
      deletedAt: 1_000,
      historyLines: ['baseline'],
      versions: [],
      finalState: ['final state'],
    });

    const result: FolderDeltaResult = FolderDeltaHelper.compareAt(tombstone, 2_000);

    expect(result.status).toBe('none');
    expect(result.base).toEqual([]);
    expect(result.current).toEqual([]);
  });

  it('returns none when a tombstone was deleted exactly at T', () => {
    // The boundary is strict: deletedTimestamp == T means "gone by then".
    const tombstone: FileSnapshot = makeTombstone({
      path: 'root/a.md',
      createdAt: 500,
      deletedAt: 2_000,
      historyLines: ['baseline'],
      versions: [],
      finalState: ['final state'],
    });

    const result: FolderDeltaResult = FolderDeltaHelper.compareAt(tombstone, 2_000);

    expect(result.status).toBe('none');
  });

  it('returns added (not deleted) when the tombstone was created after T', () => {
    // A tombstone that came into being after T never existed at T, even
    // though it is gone now: from T's point of view there is no row to show.
    // The defensive answer here is 'none' (didn't exist at T AND doesn't
    // exist now), matching the !existsNow && !existedAtT cell.
    const tombstone: FileSnapshot = makeTombstone({
      path: 'root/a.md',
      createdAt: 5_000,
      deletedAt: 6_000,
      historyLines: ['baseline'],
      versions: [],
      finalState: ['final state'],
    });

    const result: FolderDeltaResult = FolderDeltaHelper.compareAt(tombstone, 1_000);

    expect(result.status).toBe('none');
    expect(result.base).toEqual([]);
    expect(result.current).toEqual([]);
  });
});

describe('FolderDeltaHelper.compareAt - live content equality', () => {
  it('returns none when the resolved content at T equals the current state', () => {
    // AC6: live snapshot whose content at T equals its current state -> 'none'.
    const snapshot: FileSnapshot = makeLiveSnapshot({
      path: 'root/a.md',
      createdAt: 500,
      historyLines: ['same'],
      versions: [{ timestamp: 1_000, lines: ['same content'] }],
      state: ['same content'],
    });

    const result: FolderDeltaResult = FolderDeltaHelper.compareAt(snapshot, 2_000);

    expect(result.status).toBe('none');
    expect(result.base).toEqual(['same content']);
    expect(result.current).toEqual(['same content']);
  });

  it('returns modified when the resolved base differs from the current state', () => {
    const snapshot: FileSnapshot = makeLiveSnapshot({
      path: 'root/a.md',
      createdAt: 500,
      historyLines: ['baseline'],
      versions: [{ timestamp: 1_000, lines: ['old content'] }],
      state: ['new content'],
    });

    const result: FolderDeltaResult = FolderDeltaHelper.compareAt(snapshot, 2_000);

    expect(result.status).toBe('modified');
    expect(result.base).toEqual(['old content']);
    expect(result.current).toEqual(['new content']);
  });

  it('treats arrays differing only in length as not equal', () => {
    const snapshot: FileSnapshot = makeLiveSnapshot({
      path: 'root/a.md',
      createdAt: 500,
      historyLines: ['line1'],
      versions: [{ timestamp: 1_000, lines: ['line1'] }],
      state: ['line1', 'line2'],
    });

    const result: FolderDeltaResult = FolderDeltaHelper.compareAt(snapshot, 2_000);

    expect(result.status).toBe('modified');
    expect(result.base).toEqual(['line1']);
    expect(result.current).toEqual(['line1', 'line2']);
  });
});

describe('FolderDeltaHelper.compareAt - returned content is detached', () => {
  it('returns a copy of the version lines so callers cannot mutate the snapshot', () => {
    const snapshot: FileSnapshot = makeLiveSnapshot({
      path: 'root/a.md',
      createdAt: 500,
      historyLines: ['baseline'],
      versions: [{ timestamp: 1_000, lines: ['original'] }],
      state: ['live'],
    });

    const result: FolderDeltaResult = FolderDeltaHelper.compareAt(snapshot, 2_000);

    result.base.push('tampered');
    result.current.push('tampered');

    expect(snapshot.versions[0].getLines()).toEqual(['original']);
    expect(snapshot.state).toEqual(['live']);
  });

  it('returns a copy of the history baseline when used as the fallback base', () => {
    const snapshot: FileSnapshot = makeLiveSnapshot({
      path: 'root/a.md',
      createdAt: 500,
      historyLines: ['baseline'],
      versions: [{ timestamp: 5_000, lines: ['later'] }],
      state: ['live'],
    });

    const result: FolderDeltaResult = FolderDeltaHelper.compareAt(snapshot, 1_000);

    result.base.push('tampered');

    expect(snapshot.historyLines).toEqual(['baseline']);
  });
});
