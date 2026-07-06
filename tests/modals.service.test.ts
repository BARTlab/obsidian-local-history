import 'reflect-metadata';
import { describe, expect, it } from 'vitest';

import { ModalsService } from '@/services/modals.service';
import { FileSnapshot } from '@/snapshots/file.snapshot';
import { SnapshotCodec } from '@/snapshots/snapshot-codec';
import type { SerializedFileSnapshot } from '@/types';

import { makeFile, makeInjectHost } from './helpers/builders';

/**
 * Exposes the protected `isUnderFolder` predicate on a real, fully-constructed
 * service instance. The `@Inject` fields install throwing setters and resolve
 * lazily through `plugin.get`, but `isUnderFolder` reads neither injected
 * service, so a bare container host suffices; the method runs on genuine
 * instance state instead of a prototype cast that bypassed construction.
 */
class TestModalsService extends ModalsService {
  public underFolder(snapshot: FileSnapshot, rootPath: string): boolean {
    return this.isUnderFolder(snapshot, rootPath);
  }
}

const service: TestModalsService = new TestModalsService(
  makeInjectHost() as unknown as ConstructorParameters<typeof ModalsService>[0],
);

const isUnderFolder = (snapshot: FileSnapshot, rootPath: string): boolean =>
  service.underFolder(snapshot, rootPath);

describe('ModalsService.isUnderFolder - path resolution', () => {
  it('places a live snapshot under its folder by file.path', () => {
    const snapshot: FileSnapshot = new FileSnapshot('a\nb', '\n', makeFile('folder/sub/note.md'));

    expect(isUnderFolder(snapshot, 'folder')).toBe(true);
    expect(isUnderFolder(snapshot, 'folder/sub')).toBe(true);
  });

  it('places a restored snapshot with file = null under its folder by carried path', () => {
    // After a reload a restored snapshot whose file did not resolve has
    // file = null but keeps its canonical map-key path; it must still be
    // included under its folder instead of being filtered out by an empty path.
    const snapshot: FileSnapshot = new FileSnapshot('a\nb', '\n', null);

    snapshot.path = 'folder/sub/note.md';

    expect(isUnderFolder(snapshot, 'folder')).toBe(true);
    expect(isUnderFolder(snapshot, 'folder/sub')).toBe(true);
  });

  it('excludes a null-file snapshot from an unrelated folder by carried path', () => {
    const snapshot: FileSnapshot = new FileSnapshot('a', '\n', null);

    snapshot.path = 'folder/sub/note.md';

    expect(isUnderFolder(snapshot, 'other')).toBe(false);
  });

  it('prefers the live file.path over a stale carried path', () => {
    const snapshot: FileSnapshot = new FileSnapshot('a', '\n', makeFile('root/live.md'));

    snapshot.path = 'stale/old.md';

    expect(isUnderFolder(snapshot, 'root')).toBe(true);
    expect(isUnderFolder(snapshot, 'stale')).toBe(false);
  });

  it('filters out a snapshot with neither a file nor a carried path', () => {
    const snapshot: FileSnapshot = new FileSnapshot('a', '\n', null);

    expect(isUnderFolder(snapshot, 'folder')).toBe(false);
  });
});

describe('FileSnapshot path persistence', () => {
  it('seeds path from file.path on construction', () => {
    const snapshot: FileSnapshot = new FileSnapshot('a', '\n', makeFile('folder/note.md'));

    expect(snapshot.path).toBe('folder/note.md');
  });

  it('serializes the carried path when file is null', () => {
    const snapshot: FileSnapshot = new FileSnapshot('a', '\n', null);

    snapshot.path = 'folder/gone.md';

    expect(SnapshotCodec.encode(snapshot).path).toBe('folder/gone.md');
  });

  it('round-trips a null-file snapshot path through toJSON/fromJSON', () => {
    const snapshot: FileSnapshot = new FileSnapshot('a', '\n', null);

    snapshot.path = 'folder/gone.md';

    const serialized: SerializedFileSnapshot = SnapshotCodec.encode(snapshot);
    const restored: FileSnapshot = SnapshotCodec.decode(serialized, null);

    expect(restored.path).toBe('folder/gone.md');
    expect(restored.file ?? null).toBeNull();
  });
});
