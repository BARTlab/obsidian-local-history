import 'reflect-metadata';
import { describe, expect, it } from '@jest/globals';

import type { SnapshotsService } from '@/services/snapshots.service';
import type { FileSnapshot } from '@/snapshots/file.snapshot';
import { FileVersion } from '@/snapshots/file.version';
import type { TFile } from 'obsidian';

import { makeFile } from './helpers/builders';
import { makeSnapshotsService as makeService } from './helpers/service-factories';

/**
 * Seeds the service with a live snapshot at `file.path` and decorates it with a
 * captured intermediate version so the tombstone path has non-trivial state to
 * preserve. The live snapshot's marker baseline and tracker are deliberately
 * non-empty so the test can prove they are dropped on tombstone.
 */
const seedLiveSnapshot = (service: SnapshotsService, file: TFile): FileSnapshot => {
  service.add(file, 'one\ntwo\nthree');
  const snapshot: FileSnapshot | null = service.getOne(file);

  expect(snapshot).not.toBeNull();

  // Mutate the current state and push a version so we can assert that the
  // history baseline, current state, and timeline all survive a tombstone.
  snapshot!.updateState(['one', 'two-edited', 'three']);
  snapshot!.versions.push(new FileVersion(['one', 'two', 'three']));

  return snapshot as FileSnapshot;
};

describe('SnapshotsService.markDeleted', () => {
  it('keeps the entry in the map and flips it into a tombstone', () => {
    const service = makeService();
    const file = makeFile('notes/a.md');

    seedLiveSnapshot(service, file);

    service.markDeleted(file);

    const tombstone: FileSnapshot | null = service.getOne(file);

    expect(tombstone).not.toBeNull();
    expect(tombstone!.isTombstone()).toBe(true);
    expect(typeof tombstone!.deletedTimestamp).toBe('number');
  });

  it('preserves historyLines, versions, and current state on the tombstone', () => {
    const service = makeService();
    const file = makeFile('notes/a.md');

    const live: FileSnapshot = seedLiveSnapshot(service, file);
    const historyBefore: string[] = live.getHistoryOriginalStateLines();
    const stateBefore: string[] = live.getLastStateLines();
    const versionsBefore: FileVersion[] = [...live.versions];

    service.markDeleted(file);

    const tombstone: FileSnapshot = service.getOne(file) as FileSnapshot;

    expect(tombstone.getHistoryOriginalStateLines()).toEqual(historyBefore);
    expect(tombstone.getLastStateLines()).toEqual(stateBefore);
    expect(tombstone.versions).toEqual(versionsBefore);
  });

  it('drops the session-only marker baseline and tracker on the tombstone', () => {
    const service = makeService();
    const file = makeFile('notes/a.md');

    seedLiveSnapshot(service, file);

    service.markDeleted(file);

    const tombstone: FileSnapshot = service.getOne(file) as FileSnapshot;

    expect(tombstone.lines).toEqual([]);
    expect(tombstone.getTrackerLines()).toEqual([]);
    expect(tombstone.getChangesLinesCount()).toBe(0);
  });

  it('getOne for a still-resolvable TFile returns the tombstone', () => {
    const service = makeService();
    const file = makeFile('notes/a.md');

    seedLiveSnapshot(service, file);
    service.markDeleted(file);

    // Simulate the delete handler still holding the TFile reference: getOne
    // must surface the tombstone keyed under its last-known path.
    const resolved: FileSnapshot | null = service.getOne(file);

    expect(resolved).not.toBeNull();
    expect(resolved!.isTombstone()).toBe(true);
  });

  it('removeFromIgnoreList still succeeds after markDeleted', () => {
    const service = makeService();
    const file = makeFile('notes/a.md');

    seedLiveSnapshot(service, file);
    service.addToIgnoreList(file);

    expect(() => {
      service.markDeleted(file);
      service.removeFromIgnoreList(file);
    }).not.toThrow();

    expect(service.isInIgnoreList(file)).toBe(false);
  });

  it('is a no-op when no snapshot exists at the path', () => {
    const service = makeService();
    const file = makeFile('notes/missing.md');

    service.markDeleted(file);

    expect(service.getOne(file)).toBeNull();
  });

  it('does not rewrite an already-tombstoned entry', () => {
    const service = makeService();
    const file = makeFile('notes/a.md');

    seedLiveSnapshot(service, file);
    service.markDeleted(file);

    const tombstone: FileSnapshot = service.getOne(file) as FileSnapshot;
    const originalTimestamp: number = tombstone.deletedTimestamp as number;

    // Second call must keep the original tombstone moment intact: the delete
    // happened once, even if a replay of the same signal arrives later.
    service.markDeleted(file);

    expect(tombstone.deletedTimestamp).toBe(originalTimestamp);
  });
});
