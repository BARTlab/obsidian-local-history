import 'reflect-metadata';
import { describe, expect, it } from '@jest/globals';

import { FolderDeltaHelper } from '@/helpers/folder-delta.helper';
import type { FolderDeltaResult } from '@/types';
import { FileSnapshot } from '@/snapshots/file.snapshot';
import { FileVersion } from '@/snapshots/file.version';

import { makeFile } from './helpers/builders';

/**
 * Builds a live snapshot whose creation timestamp, history baseline, version
 * timeline, and current `state` are all explicit so the AC grid can be pinned
 * without depending on Date.now() or capture cadence side-effects.
 */
const makeLiveSnapshot = (params: {
  path: string;
  createdAt: number;
  historyLines?: string[];
  versions?: { timestamp: number; lines: string[] }[];
  state?: string[];
}): FileSnapshot => {
  const history: string[] = params.historyLines ?? ['baseline'];
  const snapshot: FileSnapshot = new FileSnapshot(history.join('\n'), '\n', makeFile(params.path));

  snapshot.timestamp = params.createdAt;
  snapshot.content.historyLines = [...history];
  snapshot.timeline.adopt((params.versions ?? []).map(
    (entry: { timestamp: number; lines: string[] }): FileVersion => new FileVersion(entry.lines, entry.timestamp),
  ));
  snapshot.content.updateState(params.state ?? history);

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
  versions?: { timestamp: number; lines: string[] }[];
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

  it('treats a file with versions older than its creation stamp as existing at T', () => {
    // Regression: snapshot.timestamp is reset to "now" whenever the snapshot
    // object is rebuilt (every session a file is captured), so it routinely
    // drifts NEWER than the file's own captured versions. Resolving existence
    // from timestamp alone mislabelled such a file 'added' (empty base, all-green
    // diff) at every folder-timeline point before that stamp - the "swapped
    // trees" bug. The earliest version is the reliable existence floor.
    const snapshot: FileSnapshot = makeLiveSnapshot({
      path: 'root/a.md',
      createdAt: 9_000,
      historyLines: ['baseline'],
      versions: [
        { timestamp: 1_000, lines: ['v1'] },
        { timestamp: 3_000, lines: ['v2'] },
      ],
      state: ['current'],
    });

    const result: FolderDeltaResult = FolderDeltaHelper.compareAt(snapshot, 2_000);

    expect(result.status).toBe('modified');
    expect(result.base).toEqual(['v1']);
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

  it('returns deleted when a tombstone was deleted exactly at T', () => {
    // The delete boundary is inclusive: a tombstone is still surfaced as
    // 'deleted' on the very timeline point that represents its deletion (or its
    // move-out, whose tombstone is stamped at the move instant). An exclusive
    // bound hid the deleted file on its own point and made the newest snapshot
    // look empty.
    const tombstone: FileSnapshot = makeTombstone({
      path: 'root/a.md',
      createdAt: 500,
      deletedAt: 2_000,
      historyLines: ['baseline'],
      versions: [],
      finalState: ['final state'],
    });

    const result: FolderDeltaResult = FolderDeltaHelper.compareAt(tombstone, 2_000);

    expect(result.status).toBe('deleted');
  });

  it('returns none once T is strictly past the deletion instant', () => {
    // One millisecond after the deletion the file is gone for good: it neither
    // exists now nor existed at T, so the folder tree skips the row.
    const tombstone: FileSnapshot = makeTombstone({
      path: 'root/a.md',
      createdAt: 500,
      deletedAt: 2_000,
      historyLines: ['baseline'],
      versions: [],
      finalState: ['final state'],
    });

    const result: FolderDeltaResult = FolderDeltaHelper.compareAt(tombstone, 2_001);

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

describe('FolderDeltaHelper.compareAt - moved-in snapshot', () => {
  /**
   * Builds a live snapshot re-keyed to a destination path by a cross-directory
   * move: same shape `SnapshotsService.markMoved` leaves behind, with
   * `movedIntoAt` stamped at the move instant and the file's content carried
   * across unchanged.
   */
  const makeMoved = (params: {
    path: string;
    createdAt: number;
    movedIntoAt: number;
    content: string[];
  }): FileSnapshot => {
    const snapshot: FileSnapshot = makeLiveSnapshot({
      path: params.path,
      createdAt: params.createdAt,
      historyLines: params.content,
      versions: [],
      state: params.content,
    });

    snapshot.movedIntoAt = params.movedIntoAt;

    return snapshot;
  };

  it('renders the moved file as added at its destination on the move instant', () => {
    // The move-in timeline point sits exactly at movedIntoAt. The file appears
    // at its destination path only strictly after the move, so on that point it
    // reads as freshly added to the folder (the tombstone left at the old path
    // reads as deleted on the same point - together they spell out a move).
    const moved: FileSnapshot = makeMoved({
      path: 'root/sub/a.md',
      createdAt: 1_000,
      movedIntoAt: 5_000,
      content: ['kept'],
    });

    const result: FolderDeltaResult = FolderDeltaHelper.compareAt(moved, 5_000);

    expect(result.status).toBe('added');
    expect(result.base).toEqual([]);
    expect(result.current).toEqual(['kept']);
  });

  it('renders the moved file as added at points before the move', () => {
    const moved: FileSnapshot = makeMoved({
      path: 'root/sub/a.md',
      createdAt: 1_000,
      movedIntoAt: 5_000,
      content: ['kept'],
    });

    const result: FolderDeltaResult = FolderDeltaHelper.compareAt(moved, 3_000);

    expect(result.status).toBe('added');
  });

  it('hides an unchanged moved file once T is strictly past the move', () => {
    // After the move settles, an unchanged file has no diff against its own
    // content, so it drops out of the changed-files tree (status none).
    const moved: FileSnapshot = makeMoved({
      path: 'root/sub/a.md',
      createdAt: 1_000,
      movedIntoAt: 5_000,
      content: ['kept'],
    });

    const result: FolderDeltaResult = FolderDeltaHelper.compareAt(moved, 6_000);

    expect(result.status).toBe('none');
  });
});

describe('FolderDeltaHelper.compareAt - live file with no captured versions', () => {
  /**
   * Builds a live snapshot edited once below the capture cadence: no
   * intermediate versions, a history baseline that differs from the current
   * state, and a real file mtime (distinct from the snapshot's creation stamp)
   * marking when that single edit landed.
   */
  const makeNoVersionSnapshot = (params: {
    createdAt: number;
    mtime: number;
    baseline: string[];
    current: string[];
  }): FileSnapshot => {
    const snapshot: FileSnapshot = makeLiveSnapshot({
      path: 'root/a.md',
      createdAt: params.createdAt,
      historyLines: params.baseline,
      versions: [],
      state: params.current,
    });

    (snapshot.file as unknown as { stat: { mtime: number } }).stat = { mtime: params.mtime };

    return snapshot;
  };

  it('reads as modified at points before the single edit', () => {
    // firstSeen (createdAt) <= T < mtime: the file existed but had not yet been
    // edited, so the content at T is the baseline and differs from current.
    const snapshot: FileSnapshot = makeNoVersionSnapshot({
      createdAt: 1_000,
      mtime: 5_000,
      baseline: ['old'],
      current: ['new'],
    });

    const result: FolderDeltaResult = FolderDeltaHelper.compareAt(snapshot, 3_000);

    expect(result.status).toBe('modified');
    expect(result.base).toEqual(['old']);
    expect(result.current).toEqual(['new']);
  });

  it('reads as none at points at or after the single edit (mtime)', () => {
    // T >= mtime: the file already holds its current content at T, so nothing
    // changed between T and now - it drops out of the changed-files tree instead
    // of showing as modified at every point the way the baseline-only fallback did.
    const snapshot: FileSnapshot = makeNoVersionSnapshot({
      createdAt: 1_000,
      mtime: 5_000,
      baseline: ['old'],
      current: ['new'],
    });

    expect(FolderDeltaHelper.compareAt(snapshot, 5_000).status).toBe('none');
    expect(FolderDeltaHelper.compareAt(snapshot, 6_000).status).toBe('none');
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

    expect(snapshot.timeline.getStoredVersions()[0].getLines()).toEqual(['original']);
    expect(snapshot.content.state).toEqual(['live']);
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

    expect(snapshot.content.historyLines).toEqual(['baseline']);
  });
});
