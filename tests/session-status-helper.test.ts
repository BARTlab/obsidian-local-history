import { describe, expect, it } from '@jest/globals';

import { FolderDeltaStatus } from '@/consts';
import { SessionStatusHelper } from '@/helpers/session-status.helper';
import { FileSnapshot } from '@/snapshots/file.snapshot';

import { makeFile } from './helpers/builders';

/**
 * Builds a clean live snapshot with no session changes (no edits, not created
 * this run, not a tombstone): the baseline `none` case.
 */
const makeClean = (path: string = 'a.md'): FileSnapshot =>
  new FileSnapshot('a\nb\nc', '\n', makeFile(path));

/**
 * Drives a snapshot through a real one-line edit so `getChangesLinesCount()`
 * reports a genuine session modification, mirroring how the persistence tests
 * fabricate a dirty snapshot.
 */
const makeModified = (path: string = 'a.md'): FileSnapshot => {
  const snapshot: FileSnapshot = makeClean(path);

  snapshot.trackers.findCurrentLine(1)?.change('B');
  snapshot.updateState(['a', 'B', 'c']);
  snapshot.updateChanges();

  return snapshot;
};

describe('SessionStatusHelper.statusOf', () => {
  it('returns none for a tombstoned snapshot (deleted is out of scope)', () => {
    const snapshot: FileSnapshot = makeClean();
    snapshot.deletedTimestamp = 1_000;

    expect(SessionStatusHelper.statusOf(snapshot)).toBe(FolderDeltaStatus.none);
  });

  it('returns added for a snapshot created this session with no prior history', () => {
    const snapshot: FileSnapshot = makeClean();
    snapshot.createdThisSession = true;

    expect(SessionStatusHelper.statusOf(snapshot)).toBe(FolderDeltaStatus.added);
  });

  it('returns modified for a snapshot with changed lines (marker baseline)', () => {
    const snapshot: FileSnapshot = makeModified();

    expect(snapshot.getChangesLinesCount()).toBeGreaterThan(0);
    expect(SessionStatusHelper.statusOf(snapshot)).toBe(FolderDeltaStatus.modified);
  });

  it('returns none for an unchanged, non-tombstone, non-new snapshot', () => {
    const snapshot: FileSnapshot = makeClean();

    expect(SessionStatusHelper.statusOf(snapshot)).toBe(FolderDeltaStatus.none);
  });

  it('prefers added over modified when a snapshot is both created and changed', () => {
    const snapshot: FileSnapshot = makeModified();
    snapshot.createdThisSession = true;

    expect(snapshot.getChangesLinesCount()).toBeGreaterThan(0);
    expect(SessionStatusHelper.statusOf(snapshot)).toBe(FolderDeltaStatus.added);
  });
});

describe('SessionStatusHelper.ancestorFolderPaths', () => {
  it('yields every ancestor folder of a nested file (a/b/c.md -> a, a/b)', () => {
    const folders: Set<string> = SessionStatusHelper.ancestorFolderPaths(['a/b/c.md']);

    expect([...folders].sort()).toEqual(['a', 'a/b']);
  });

  it('returns an empty set for a file at the vault root (no parent folder)', () => {
    expect(SessionStatusHelper.ancestorFolderPaths(['c.md']).size).toBe(0);
  });

  it('deduplicates folders shared by sibling changed files', () => {
    const folders: Set<string> = SessionStatusHelper.ancestorFolderPaths([
      'a/b/c.md',
      'a/b/d.md',
      'a/e.md',
    ]);

    expect([...folders].sort()).toEqual(['a', 'a/b']);
  });

  it('returns an empty set for no changed paths', () => {
    expect(SessionStatusHelper.ancestorFolderPaths([]).size).toBe(0);
  });
});
