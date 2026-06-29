import 'reflect-metadata';
import { describe, expect, it } from '@jest/globals';

import { PathHelper } from '@/helpers/path.helper';
import type { SnapshotsService } from '@/services/snapshots.service';
import type { FileSnapshot } from '@/snapshots/file.snapshot';
import { FileVersion } from '@/snapshots/file.version';
import type { TFile } from 'obsidian';

import { makeFile } from './helpers/builders';
import { makeSnapshotsService as makeService } from './helpers/service-factories';

/**
 * Seeds the service with a live snapshot at the source path, decorated with a
 * mutated current state and a captured version so the move path has non-trivial
 * history to migrate.
 */
const seedLiveSnapshot = (service: SnapshotsService, file: TFile): FileSnapshot => {
  service.add(file, 'one\ntwo\nthree');
  const snapshot: FileSnapshot | null = service.getOne(file);

  expect(snapshot).not.toBeNull();

  snapshot!.updateState(['one', 'two-edited', 'three']);
  snapshot!.versions.push(new FileVersion(['one', 'two', 'three']));

  return snapshot as FileSnapshot;
};

describe('PathHelper.dirname', () => {
  it('returns the parent directory for a nested path', () => {
    expect(PathHelper.dirname('src/a.md')).toBe('src');
    expect(PathHelper.dirname('a/b/c.md')).toBe('a/b');
  });

  it('returns an empty string for a vault-root path', () => {
    expect(PathHelper.dirname('a.md')).toBe('');
  });

  it('returns an empty string for an empty input', () => {
    expect(PathHelper.dirname('')).toBe('');
  });

  it('returns an empty string for a path with a leading slash and no other separator', () => {
    // A leading slash means "vault root" semantically; there is no enclosing
    // directory to name, so dirname must not return the slash itself.
    expect(PathHelper.dirname('/a.md')).toBe('');
  });
});

describe('SnapshotsService.markMoved', () => {
  it('re-keys the live snapshot to the destination with movedIntoAt set', () => {
    const service = makeService();
    const source = makeFile('src/a.md');
    const dest = makeFile('dst/a.md');

    seedLiveSnapshot(service, source);

    service.markMoved('src/a.md', dest);

    const moved: FileSnapshot | null = service.getOne(dest);

    expect(moved).not.toBeNull();
    expect(moved!.isTombstone()).toBe(false);
    expect(moved!.isMovedIn()).toBe(true);
    expect(typeof moved!.movedIntoAt).toBe('number');
    expect(moved!.file?.path).toBe('dst/a.md');
  });

  it('leaves a tombstone at the source path mirroring the live state and history', () => {
    const service = makeService();
    const source = makeFile('src/a.md');
    const dest = makeFile('dst/a.md');

    const live: FileSnapshot = seedLiveSnapshot(service, source);
    const historyBefore: string[] = live.getHistoryOriginalStateLines();
    const stateBefore: string[] = live.getLastStateLines();
    const versionsBefore: FileVersion[] = [...live.versions];

    service.markMoved('src/a.md', dest);

    const tombstone: FileSnapshot | null = service.getOne(source);

    expect(tombstone).not.toBeNull();
    expect(tombstone!.isTombstone()).toBe(true);
    expect(typeof tombstone!.deletedTimestamp).toBe('number');
    expect(tombstone!.getHistoryOriginalStateLines()).toEqual(historyBefore);
    expect(tombstone!.getLastStateLines()).toEqual(stateBefore);
    expect(tombstone!.versions.map((version: FileVersion): string => version.getContent('\n')))
      .toEqual(versionsBefore.map((version: FileVersion): string => version.getContent('\n')));
  });

  it('drops the session-only marker baseline and tracker on the tombstone', () => {
    const service = makeService();
    const source = makeFile('src/a.md');
    const dest = makeFile('dst/a.md');

    seedLiveSnapshot(service, source);

    service.markMoved('src/a.md', dest);

    const tombstone: FileSnapshot = service.getOne(source) as FileSnapshot;

    expect(tombstone.lines).toEqual([]);
    expect(tombstone.trackers.getTrackerLines()).toEqual([]);
    expect(tombstone.getChangesLinesCount()).toBe(0);
  });

  it('getList returns both records and only the destination is live', () => {
    const service = makeService();
    const source = makeFile('src/a.md');
    const dest = makeFile('dst/a.md');

    seedLiveSnapshot(service, source);
    service.markMoved('src/a.md', dest);

    const list: FileSnapshot[] = service.getList();
    const tombstones: FileSnapshot[] = list.filter((entry: FileSnapshot): boolean => entry.isTombstone());
    const live: FileSnapshot[] = list.filter((entry: FileSnapshot): boolean => !entry.isTombstone());

    expect(list).toHaveLength(2);
    expect(tombstones).toHaveLength(1);
    expect(live).toHaveLength(1);
    expect(live[0]!.file?.path).toBe('dst/a.md');
  });

  it('throws when the directory does not change (rename keeps re-key)', () => {
    const service = makeService();
    const source = makeFile('src/a.md');
    const sameDir = makeFile('src/b.md');

    seedLiveSnapshot(service, source);

    expect(() => service.markMoved('src/a.md', sameDir)).toThrow(/markMoved/);
  });

  it('throws when both paths sit at the vault root', () => {
    const service = makeService();
    const source = makeFile('a.md');
    const sameRoot = makeFile('b.md');

    seedLiveSnapshot(service, source);

    expect(() => service.markMoved('a.md', sameRoot)).toThrow(/markMoved/);
  });

  it('is a no-op when no snapshot exists at the source path', () => {
    const service = makeService();
    const dest = makeFile('dst/a.md');

    service.markMoved('src/missing.md', dest);

    expect(service.getOne(dest)).toBeNull();
    expect(service.getList()).toHaveLength(0);
  });

  it('is a no-op when oldPath equals the new file path', () => {
    const service = makeService();
    const source = makeFile('src/a.md');

    seedLiveSnapshot(service, source);

    service.markMoved('src/a.md', source);

    expect(service.getList()).toHaveLength(1);
    expect(service.getOne(source)!.isTombstone()).toBe(false);
    expect(service.getOne(source)!.isMovedIn()).toBe(false);
  });

  it('handles moves to and from the vault root', () => {
    const service = makeService();
    const source = makeFile('src/a.md');
    const root = makeFile('a.md');

    seedLiveSnapshot(service, source);

    service.markMoved('src/a.md', root);

    expect(service.getOne(root)!.isMovedIn()).toBe(true);
    expect(service.getOne(source)!.isTombstone()).toBe(true);
  });
});
