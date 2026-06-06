import 'reflect-metadata';
import { describe, expect, it } from '@jest/globals';

import { ModalsService } from '@/services/modals.service';
import { FileSnapshot } from '@/snapshots/file.snapshot';
import type { SerializedFileSnapshot } from '@/types';
import type { TFile } from 'obsidian';

/**
 * Builds a minimal `TFile`-like object carrying only the `path` the folder
 * prefix matcher reads.
 */
const makeFile = (path: string): TFile => ({ path } as unknown as TFile);

/**
 * Exposes the protected `isUnderFolder` predicate without standing up the full
 * service (the `@Inject` decorator installs a throwing setter, and the real
 * constructor expects a live plugin). `Object.create` bypasses construction and
 * the method under test reads nothing but its two arguments.
 */
type IsUnderFolderFn = (snapshot: FileSnapshot, rootPath: string) => boolean;

const isUnderFolder: IsUnderFolderFn = (
  ModalsService.prototype as unknown as { isUnderFolder: IsUnderFolderFn }
).isUnderFolder;

describe('ModalsService.isUnderFolder - path resolution (epic 12)', () => {
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

describe('FileSnapshot path persistence (epic 12)', () => {
  it('seeds path from file.path on construction', () => {
    const snapshot: FileSnapshot = new FileSnapshot('a', '\n', makeFile('folder/note.md'));

    expect(snapshot.path).toBe('folder/note.md');
  });

  it('serializes the carried path when file is null', () => {
    const snapshot: FileSnapshot = new FileSnapshot('a', '\n', null);

    snapshot.path = 'folder/gone.md';

    expect(snapshot.toJSON().path).toBe('folder/gone.md');
  });

  it('round-trips a null-file snapshot path through toJSON/fromJSON', () => {
    const snapshot: FileSnapshot = new FileSnapshot('a', '\n', null);

    snapshot.path = 'folder/gone.md';

    const serialized: SerializedFileSnapshot = snapshot.toJSON();
    const restored: FileSnapshot = FileSnapshot.fromJSON(serialized, null);

    expect(restored.path).toBe('folder/gone.md');
    expect(restored.file ?? null).toBeNull();
  });
});
