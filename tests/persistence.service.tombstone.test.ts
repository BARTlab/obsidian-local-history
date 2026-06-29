import 'reflect-metadata';
import { describe, expect, it } from '@jest/globals';

import type { SnapshotsService } from '@/services/snapshots.service';
import type { FileSnapshot } from '@/snapshots/file.snapshot';
import { FileVersion } from '@/snapshots/file.version';
import type { SerializedFileSnapshot } from '@/types';
import type { TFile } from 'obsidian';

import { makeFile } from './helpers/builders';
import { makeSnapshotsServiceWithPaths as makeService } from './helpers/service-factories';

/**
 * Tests for PersistenceService serialize/restore tombstones + orphan
 * handling. These exercise SnapshotsService.serialize and restore directly so
 * the round-trip is verified without touching the disk-IO layer that wraps
 * them; the disk path itself is covered by persistence.service.test.ts.
 */

/**
 * Seeds the service with a live snapshot, mutates its state, and captures a
 * version so the entry has non-trivial history to preserve across a tombstone
 * round-trip.
 */
const seedLiveSnapshot = (service: SnapshotsService, file: TFile): FileSnapshot => {
  service.add(file, 'one\ntwo\nthree');
  const snapshot: FileSnapshot | null = service.getOne(file);

  expect(snapshot).not.toBeNull();

  snapshot!.content.updateState(['one', 'two-edited', 'three']);
  snapshot!.timeline.adopt([new FileVersion(['one', 'two', 'three'])]);

  return snapshot as FileSnapshot;
};

describe('SnapshotsService.serialize with tombstones', () => {
  it('includes a tombstone snapshot even when no current changes remain', () => {
    const service = makeService();
    const file = makeFile('notes/gone.md');

    service.add(file, 'a\nb\nc');
    // No edits, no versions: a live snapshot here would be skipped by the
    // "no history" filter. The tombstone must override that and ship anyway.
    service.markDeleted(file);

    const payload = service.serialize();

    expect(payload.snapshots).toHaveLength(1);
    expect(payload.snapshots[0].path).toBe('notes/gone.md');
    expect(typeof payload.snapshots[0].deletedTimestamp).toBe('number');
  });

  it('serializes a detached tombstone (file = null) under its map-key path', () => {
    // A cross-directory move leaves a tombstone at the source whose file
    // reference is null (the migrating snapshot holds the new TFile). Without
    // the map-key fallback, toJSON would write `path: ''` and the entry would
    // be dropped at restore.
    const service = makeService();
    const sourceFile = makeFile('src/a.md');

    seedLiveSnapshot(service, sourceFile);

    const destinationFile = makeFile('dst/a.md');

    service.markMoved('src/a.md', destinationFile);

    const payload = service.serialize();
    const paths: string[] = payload.snapshots.map((entry: SerializedFileSnapshot): string => entry.path);

    expect(paths).toContain('src/a.md');
    expect(paths).toContain('dst/a.md');
  });

  it('keeps a pristine live snapshot out of the payload', () => {
    // The previous filter behaviour for live snapshots is preserved: a clean
    // file with no tracker changes and no versions still does not bloat disk.
    const service = makeService();
    const file = makeFile('notes/clean.md');

    service.add(file, 'pristine');

    const payload = service.serialize();

    expect(payload.snapshots).toHaveLength(0);
  });
});

describe('SnapshotsService.restore with tombstones', () => {
  it('reconstructs a tombstone whose path no longer resolves to a live file', () => {
    const service = makeService();
    const file = makeFile('notes/gone.md');

    service.add(file, 'a\nb');
    service.markDeleted(file);

    const payload = service.serialize();

    const fresh = makeService([]); // gone.md is not in the vault anymore

    fresh.restore(payload.snapshots);

    const restored: FileSnapshot | null = fresh.getOne(makeFile('notes/gone.md'));

    expect(restored).not.toBeNull();
    expect(restored!.isTombstone()).toBe(true);
    // The original deletion moment survived the round-trip (it was not
    // overwritten by the auto-tombstone path that handles orphan live entries).
    expect(restored!.deletedTimestamp).toBe(payload.snapshots[0].deletedTimestamp);
  });

  it('restores a tombstone payload even when a live file at that path exists', () => {
    // The path was deleted, then a new file with the same name was created
    // while the plugin was off. The tombstone payload must still be honoured:
    // it carries deletedTimestamp, so it is a deleted-file record regardless
    // of whether something currently lives at the path.
    const service = makeService();
    const file = makeFile('notes/recycled.md');

    service.add(file, 'old');
    service.markDeleted(file);

    const payload = service.serialize();

    const fresh = makeService(['notes/recycled.md']); // a new file lives there now

    fresh.restore(payload.snapshots);

    const restored: FileSnapshot | null = fresh.getOne(makeFile('notes/recycled.md'));

    expect(restored).not.toBeNull();
    // The payload carried deletedTimestamp, so the restored entry is a
    // tombstone bearing that exact moment, not a freshly-created live snapshot.
    expect(restored!.isTombstone()).toBe(true);
    expect(restored!.deletedTimestamp).toBe(payload.snapshots[0].deletedTimestamp);
  });
});

describe('SnapshotsService.restore with live snapshots', () => {
  it('restores a live snapshot when its file still exists in the vault', () => {
    const service = makeService();
    const file = makeFile('notes/a.md');

    service.add(file, 'a\nb\nc');

    const snapshot: FileSnapshot = service.getOne(file) as FileSnapshot;

    snapshot.trackers.findCurrentLine(1)?.change('B');
    snapshot.content.updateState(['a', 'B', 'c']);
    snapshot.updateChanges();

    const payload = service.serialize();

    const fresh = makeService(['notes/a.md']);

    fresh.restore(payload.snapshots);

    const restored: FileSnapshot | null = fresh.getOne(makeFile('notes/a.md'));

    expect(restored).not.toBeNull();
    expect(restored!.isTombstone()).toBe(false);
    expect(restored!.file?.path).toBe('notes/a.md');
    // The session marker baseline is re-established on restore, so a not-yet-opened
    // live file starts session-clean; its current state and history are preserved.
    expect(restored!.content.getChangesLinesCount()).toBe(0);
    expect(restored!.content.getLastStateLines()).toEqual(['a', 'B', 'c']);
  });
});

describe('SnapshotsService.restore orphan auto-tombstoning', () => {
  it('reconstructs a live serialized entry whose file is gone as a tombstone', () => {
    const service = makeService();
    const file = makeFile('lost/z.md');

    service.add(file, 'x\ny\nz');

    const snapshot: FileSnapshot = service.getOne(file) as FileSnapshot;

    snapshot.trackers.findCurrentLine(0)?.change('X');
    snapshot.content.updateState(['X', 'y', 'z']);
    snapshot.updateChanges();

    const payload = service.serialize();
    const originalTimestamp: number = payload.snapshots[0].timestamp;

    // The file disappeared from the vault while the plugin was off, so
    // getFileByPath returns null for this path on restore.
    const fresh = makeService([]);

    fresh.restore(payload.snapshots);

    const restored: FileSnapshot | null = fresh.getOne(makeFile('lost/z.md'));

    expect(restored).not.toBeNull();
    expect(restored!.isTombstone()).toBe(true);
    // Auto-tombstoning stamps deletedTimestamp with the snapshot's last-known
    // moment (its `timestamp`), not "now": the offline disappearance is treated
    // as a delete that happened at the snapshot's recorded moment.
    expect(restored!.deletedTimestamp).toBe(originalTimestamp);
    expect(restored!.file).toBeNull();
  });

  it('keeps the persisted state and history on an auto-tombstoned orphan', () => {
    const service = makeService();
    const file = makeFile('lost/z.md');

    service.add(file, 'a\nb\nc');

    const snapshot: FileSnapshot = service.getOne(file) as FileSnapshot;

    snapshot.trackers.findCurrentLine(1)?.change('B');
    snapshot.content.updateState(['a', 'B', 'c']);
    snapshot.updateChanges();
    snapshot.timeline.adopt([new FileVersion(['a', 'mid', 'c'])]);

    const payload = service.serialize();

    const fresh = makeService([]);

    fresh.restore(payload.snapshots);

    const restored: FileSnapshot = fresh.getOne(makeFile('lost/z.md')) as FileSnapshot;

    expect(restored.content.getLastStateLines()).toEqual(['a', 'B', 'c']);
    expect(restored.content.getHistoryOriginalStateLines()).toEqual(['a', 'b', 'c']);
    expect(restored.timeline.getStoredVersions()).toHaveLength(1);
    expect(restored.timeline.getStoredVersions()[0].getLines()).toEqual(['a', 'mid', 'c']);
  });
});

describe('SnapshotsService tombstone round-trip across serialize/restore', () => {
  it('serialized tombstone -> restored tombstone preserves state, history, and versions', () => {
    const service = makeService();
    const file = makeFile('notes/a.md');

    seedLiveSnapshot(service, file);

    const live: FileSnapshot = service.getOne(file) as FileSnapshot;
    const stateBefore: string[] = live.content.getLastStateLines();
    const historyBefore: string[] = live.content.getHistoryOriginalStateLines();
    const versionsBefore: number = live.timeline.getStoredVersions().length;

    service.markDeleted(file);

    const payload = service.serialize();

    // No live file at this path in the fresh session (the file is deleted).
    const fresh = makeService([]);

    fresh.restore(payload.snapshots);

    const restored: FileSnapshot = fresh.getOne(makeFile('notes/a.md')) as FileSnapshot;

    expect(restored.isTombstone()).toBe(true);
    expect(restored.content.getLastStateLines()).toEqual(stateBefore);
    expect(restored.content.getHistoryOriginalStateLines()).toEqual(historyBefore);
    expect(restored.timeline.getStoredVersions()).toHaveLength(versionsBefore);
  });

  it('serialized cross-directory move round-trips as tombstone + live destination', () => {
    const service = makeService();
    const sourceFile = makeFile('src/a.md');

    seedLiveSnapshot(service, sourceFile);

    const destinationFile = makeFile('dst/a.md');

    service.markMoved('src/a.md', destinationFile);

    const payload = service.serialize();

    // On the fresh side, only the destination still has a live file (the
    // source path is now empty in the vault).
    const fresh = makeService(['dst/a.md']);

    fresh.restore(payload.snapshots);

    const tombstone: FileSnapshot | null = fresh.getOne(makeFile('src/a.md'));
    const live: FileSnapshot | null = fresh.getOne(makeFile('dst/a.md'));

    expect(tombstone).not.toBeNull();
    expect(tombstone!.isTombstone()).toBe(true);

    expect(live).not.toBeNull();
    expect(live!.isTombstone()).toBe(false);
    expect(live!.isMovedIn()).toBe(true);
  });
});
