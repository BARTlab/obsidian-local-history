import 'reflect-metadata';
import { describe, expect, it } from '@jest/globals';

import { FolderTimelinePointKind } from '@/consts';
import { FolderTimelineHelper } from '@/helpers/folder-timeline.helper';
import type { FolderTimelinePoint } from '@/types';
import { FileSnapshot } from '@/snapshots/file.snapshot';
import { FileVersion } from '@/snapshots/file.version';

import { makeFile } from './helpers/builders';

/**
 * Builds a live snapshot at `path` with a deterministic version timeline so the
 * tests can assert per-version timestamps without depending on Date.now().
 */
const makeLiveSnapshot = (path: string, versionTimestamps: number[] = []): FileSnapshot => {
  const snapshot: FileSnapshot = new FileSnapshot('one\ntwo\nthree', '\n', makeFile(path));

  snapshot.timeline.adopt(versionTimestamps.map(
    (timestamp: number): FileVersion => new FileVersion(['one', 'two', 'three'], timestamp),
  ));

  return snapshot;
};

/**
 * Builds a tombstone snapshot at `path` with `deletedTimestamp` set and optional
 * captured versions, matching what `SnapshotsService.markDeleted` would leave in
 * the map under the deleted file's last-known path.
 */
const makeTombstone = (
  path: string,
  deletedTimestamp: number,
  versionTimestamps: number[] = [],
): FileSnapshot => {
  const snapshot: FileSnapshot = makeLiveSnapshot(path, versionTimestamps);

  snapshot.deletedTimestamp = deletedTimestamp;

  return snapshot;
};

/**
 * Builds a snapshot whose live `file` is null but whose carried `path` mirrors
 * the canonical map key: the state of a restored snapshot after a
 * reload when `getFileByPath` did not resolve. Such a snapshot must still place
 * onto the folder timeline by its `path`, not be dropped by an empty `file.path`.
 */
const makeRestoredSnapshot = (path: string, versionTimestamps: number[] = []): FileSnapshot => {
  const snapshot: FileSnapshot = makeLiveSnapshot(path, versionTimestamps);

  snapshot.file = null;
  snapshot.path = path;

  return snapshot;
};

describe('FolderTimelineHelper.synthesize - input shapes', () => {
  it('returns an empty array for an empty iterable', () => {
    expect(FolderTimelineHelper.synthesize([], 'root')).toEqual([]);
  });

  it('returns an empty array when no snapshot lives under the prefix', () => {
    const snapshot: FileSnapshot = makeLiveSnapshot('other/a.md', [1_000]);

    expect(FolderTimelineHelper.synthesize([snapshot], 'root')).toEqual([]);
  });

  it('tolerates an undefined input without throwing', () => {
    // The helper is called from a modal where a stale ref could be undefined;
    // a defensive contract keeps the synthesizer's signature safe to call.
    expect(FolderTimelineHelper.synthesize(undefined as unknown as Iterable<FileSnapshot>, 'root'))
      .toEqual([]);
  });
});

describe('FolderTimelineHelper.synthesize - kinds emitted', () => {
  it('emits a capture point per version for snapshots under the prefix', () => {
    const snapshot: FileSnapshot = makeLiveSnapshot('root/a.md', [1_000, 2_000]);

    const points: FolderTimelinePoint[] = FolderTimelineHelper.synthesize([snapshot], 'root');

    expect(points).toHaveLength(2);
    expect(points.every((point: FolderTimelinePoint): boolean => point.kind === FolderTimelinePointKind.capture)).toBe(true);
    expect(points.map((point: FolderTimelinePoint): number => point.timestamp)).toEqual([2_000, 1_000]);
    expect(points.every((point: FolderTimelinePoint): boolean => point.path === 'root/a.md')).toBe(true);
  });

  it('emits a delete point for a tombstone with deletedTimestamp set', () => {
    const tombstone: FileSnapshot = makeTombstone('root/gone.md', 5_000);

    const points: FolderTimelinePoint[] = FolderTimelineHelper.synthesize([tombstone], 'root');

    expect(points).toEqual([
      expect.objectContaining({ kind: FolderTimelinePointKind.delete, timestamp: 5_000, path: 'root/gone.md' }),
    ]);
  });

  it('emits a move-in point for a snapshot with movedIntoAt set', () => {
    const snapshot: FileSnapshot = makeLiveSnapshot('root/moved.md');

    snapshot.movedIntoAt = 7_000;

    const points: FolderTimelinePoint[] = FolderTimelineHelper.synthesize([snapshot], 'root');

    expect(points).toEqual([
      expect.objectContaining({ kind: FolderTimelinePointKind.moveIn, timestamp: 7_000, path: 'root/moved.md' }),
    ]);
  });

  it('combines capture, delete, and move-in points from a single tombstone+move snapshot', () => {
    const snapshot: FileSnapshot = makeTombstone('root/multi.md', 9_000, [1_000, 3_000]);

    snapshot.movedIntoAt = 2_000;

    const points: FolderTimelinePoint[] = FolderTimelineHelper.synthesize([snapshot], 'root');
    const kinds: FolderTimelinePointKind[] = points.map(
      (point: FolderTimelinePoint): FolderTimelinePointKind => point.kind,
    );

    expect(points).toHaveLength(4);
    expect(points.map((point: FolderTimelinePoint): number => point.timestamp))
      .toEqual([9_000, 3_000, 2_000, 1_000]);
    expect(kinds).toEqual([
      FolderTimelinePointKind.delete,
      FolderTimelinePointKind.capture,
      FolderTimelinePointKind.moveIn,
      FolderTimelinePointKind.capture,
    ]);
  });
});

describe('FolderTimelineHelper.synthesize - path survives a null file', () => {
  it('places a restored snapshot with file = null under its folder by its carried path', () => {
    // After a reload, a restored snapshot whose file did not resolve has
    // file = null but keeps its canonical map-key path. The timeline must use
    // that path so the snapshot is not dropped by an empty file.path.
    const snapshot: FileSnapshot = makeRestoredSnapshot('folder/sub/note.md', [1_000, 2_000]);

    const points: FolderTimelinePoint[] = FolderTimelineHelper.synthesize([snapshot], 'folder');

    expect(points).toHaveLength(2);
    expect(points.every((point: FolderTimelinePoint): boolean => point.path === 'folder/sub/note.md')).toBe(true);
  });

  it('filters a null-file snapshot out of an unrelated folder by its carried path', () => {
    const snapshot: FileSnapshot = makeRestoredSnapshot('folder/sub/note.md', [1_000]);

    expect(FolderTimelineHelper.synthesize([snapshot], 'other')).toEqual([]);
  });

  it('emits a delete point for a detached tombstone (file = null) by its carried path', () => {
    // A cross-directory move leaves a detached tombstone (file = null) whose
    // path is the source map key; its delete marker must still surface.
    const tombstone: FileSnapshot = makeRestoredSnapshot('folder/gone.md');

    tombstone.deletedTimestamp = 5_000;

    const points: FolderTimelinePoint[] = FolderTimelineHelper.synthesize([tombstone], 'folder');

    expect(points).toEqual([
      expect.objectContaining({ kind: FolderTimelinePointKind.delete, timestamp: 5_000, path: 'folder/gone.md' }),
    ]);
  });

  it('prefers the live file.path over the carried path when both are present', () => {
    // A live snapshot may carry a stale `path` from before a re-key; the live
    // TFile always wins so behaviour is unchanged for the live case.
    const snapshot: FileSnapshot = makeLiveSnapshot('root/live.md', [1_000]);

    snapshot.path = 'stale/old.md';

    const points: FolderTimelinePoint[] = FolderTimelineHelper.synthesize([snapshot], 'root');

    expect(points).toHaveLength(1);
    expect(points[0].path).toBe('root/live.md');
  });
});

describe('FolderTimelineHelper.synthesize - capture point carries its version id', () => {
  it('attaches versionId for capture points and leaves it undefined for delete/move-in', () => {
    const snapshot: FileSnapshot = makeTombstone('root/m.md', 9_000, [1_000]);

    snapshot.movedIntoAt = 2_000;

    const points: FolderTimelinePoint[] = FolderTimelineHelper.synthesize([snapshot], 'root');
    const byKind: Record<string, FolderTimelinePoint | undefined> = {
      'capture': points.find((point: FolderTimelinePoint): boolean => point.kind === FolderTimelinePointKind.capture),
      'delete': points.find((point: FolderTimelinePoint): boolean => point.kind === FolderTimelinePointKind.delete),
      'move-in': points.find((point: FolderTimelinePoint): boolean => point.kind === FolderTimelinePointKind.moveIn),
    };

    expect(byKind.capture?.versionId).toBe(snapshot.timeline.getStoredVersions()[0].id);
    expect(byKind.delete?.versionId).toBeUndefined();
    expect(byKind['move-in']?.versionId).toBeUndefined();
  });
});

describe('FolderTimelineHelper.synthesize - prefix filtering', () => {
  it('keeps snapshots whose path starts with the root prefix and drops the rest', () => {
    const inside: FileSnapshot = makeLiveSnapshot('root/sub/a.md', [1_000]);
    const outside: FileSnapshot = makeLiveSnapshot('other/b.md', [2_000]);

    const points: FolderTimelinePoint[] = FolderTimelineHelper.synthesize([inside, outside], 'root');

    expect(points).toHaveLength(1);
    expect(points[0].path).toBe('root/sub/a.md');
  });

  it('does not match a path that shares only a prefix without a slash boundary', () => {
    // `roots/a.md` must not match the root `root`; only paths under `root/`
    // or equal to `root` are accepted.
    const tricky: FileSnapshot = makeLiveSnapshot('roots/a.md', [1_000]);

    expect(FolderTimelineHelper.synthesize([tricky], 'root')).toEqual([]);
  });

  it('tolerates a trailing slash on the root prefix', () => {
    const snapshot: FileSnapshot = makeLiveSnapshot('root/a.md', [1_000]);

    const points: FolderTimelinePoint[] = FolderTimelineHelper.synthesize([snapshot], 'root/');

    expect(points).toHaveLength(1);
  });

  it('an empty root matches every snapshot (whole-vault scope)', () => {
    const a: FileSnapshot = makeLiveSnapshot('a.md', [1_000]);
    const b: FileSnapshot = makeLiveSnapshot('nested/b.md', [2_000]);

    const points: FolderTimelinePoint[] = FolderTimelineHelper.synthesize([a, b], '');

    expect(points).toHaveLength(2);
  });
});

describe('FolderTimelineHelper.synthesize - ordering', () => {
  it('sorts points newest-first across multiple snapshots', () => {
    const older: FileSnapshot = makeLiveSnapshot('root/a.md', [1_000]);
    const newer: FileSnapshot = makeLiveSnapshot('root/b.md', [3_000]);
    const middle: FileSnapshot = makeLiveSnapshot('root/c.md', [2_000]);

    const points: FolderTimelinePoint[] = FolderTimelineHelper.synthesize(
      [older, newer, middle],
      'root',
    );

    expect(points.map((point: FolderTimelinePoint): number => point.timestamp))
      .toEqual([3_000, 2_000, 1_000]);
  });

  it('keeps insertion order when two points share the same timestamp', () => {
    // Two snapshots in iteration order both carry a version at t=1000. The
    // helper must not reorder them: the first iterated wins.
    const first: FileSnapshot = makeLiveSnapshot('root/first.md', [1_000]);
    const second: FileSnapshot = makeLiveSnapshot('root/second.md', [1_000]);

    const points: FolderTimelinePoint[] = FolderTimelineHelper.synthesize([first, second], 'root');

    expect(points.map((point: FolderTimelinePoint): string => point.path))
      .toEqual(['root/first.md', 'root/second.md']);
  });

  it('keeps insertion order across kinds when timestamps tie', () => {
    // A delete and a capture point on the same snapshot at the same timestamp
    // must keep their emit order: versions are emitted before the delete marker.
    const snapshot: FileSnapshot = makeTombstone('root/x.md', 1_000, [1_000]);

    const points: FolderTimelinePoint[] = FolderTimelineHelper.synthesize([snapshot], 'root');

    expect(points.map((point: FolderTimelinePoint): FolderTimelinePointKind => point.kind))
      .toEqual([FolderTimelinePointKind.capture, FolderTimelinePointKind.delete]);
  });
});

describe('FolderTimelineHelper.synthesize - day grouping keys', () => {
  it('exposes a dayKey equal to new Date(timestamp).toLocaleDateString()', () => {
    const timestamp: number = new Date(2024, 5, 17, 14, 30).getTime();
    const snapshot: FileSnapshot = makeLiveSnapshot('root/a.md', [timestamp]);

    const points: FolderTimelinePoint[] = FolderTimelineHelper.synthesize([snapshot], 'root');

    expect(points).toHaveLength(1);
    expect(points[0].dayKey).toBe(new Date(timestamp).toLocaleDateString());
  });

  it('groups two points on the same calendar day under the same dayKey', () => {
    const morning: number = new Date(2024, 5, 17, 9, 0).getTime();
    const evening: number = new Date(2024, 5, 17, 21, 0).getTime();
    const snapshot: FileSnapshot = makeLiveSnapshot('root/a.md', [morning, evening]);

    const points: FolderTimelinePoint[] = FolderTimelineHelper.synthesize([snapshot], 'root');

    expect(points).toHaveLength(2);
    expect(points[0].dayKey).toBe(points[1].dayKey);
  });

  it('uses different dayKeys for points on different calendar days', () => {
    const day1: number = new Date(2024, 5, 17, 9, 0).getTime();
    const day2: number = new Date(2024, 5, 18, 9, 0).getTime();
    const snapshot: FileSnapshot = makeLiveSnapshot('root/a.md', [day1, day2]);

    const points: FolderTimelinePoint[] = FolderTimelineHelper.synthesize([snapshot], 'root');

    expect(points).toHaveLength(2);
    expect(points[0].dayKey).not.toBe(points[1].dayKey);
  });

  it('matches FileVersion.getDate() for the same timestamp', () => {
    // The rail's day heading uses FileVersion.getDate(); the folder rail must
    // group the same calendar day under the same string.
    const timestamp: number = new Date(2024, 5, 17, 14, 30).getTime();
    const version: FileVersion = new FileVersion(['x'], timestamp);
    const snapshot: FileSnapshot = makeLiveSnapshot('root/a.md', [timestamp]);

    const points: FolderTimelinePoint[] = FolderTimelineHelper.synthesize([snapshot], 'root');

    expect(points[0].dayKey).toBe(version.getDate());
  });
});
