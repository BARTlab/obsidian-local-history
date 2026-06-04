import { describe, expect, it } from '@jest/globals';

import { FolderDeltaStatus } from '@/consts';
import { SessionStatusHelper } from '@/helpers/session-status.helper';
import { FileSnapshot } from '@/snapshots/file.snapshot';
import type { TFile } from 'obsidian';

/**
 * Minimal `TFile`-like object so a snapshot can carry a path without dragging
 * in Obsidian's full type.
 */
const makeFile = (path: string): TFile =>
  ({ path, name: path.split('/').pop() ?? path } as unknown as TFile);

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

  snapshot.findCurrentLine(1)?.change('B');
  snapshot.updateState(['a', 'B', 'c']);
  snapshot.updateChanges();

  return snapshot;
};

describe('SessionStatusHelper.statusOf', () => {
  it('returns none for a tombstoned snapshot (deleted is out of scope, D5)', () => {
    const snapshot: FileSnapshot = makeClean();
    snapshot.deletedTimestamp = 1_000;

    expect(SessionStatusHelper.statusOf(snapshot)).toBe(FolderDeltaStatus.none);
  });

  it('returns added for a snapshot created this session with no prior history', () => {
    const snapshot: FileSnapshot = makeClean();
    snapshot.createdThisSession = true;

    expect(SessionStatusHelper.statusOf(snapshot)).toBe(FolderDeltaStatus.added);
  });

  it('returns modified for a snapshot with changed lines (marker baseline, D1)', () => {
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
