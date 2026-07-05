import { describe, expect, it } from '@jest/globals';

import { FolderDeltaStatus } from '@/consts';
import * as VaultChangesHelper from '@/helpers/vault-changes.helper';
import { FileSnapshot } from '@/snapshots/file.snapshot';

import { makeFile } from './helpers/builders';

/** A clean live snapshot whose current content still equals its history origin. */
const makeClean = (path: string = 'a.md'): FileSnapshot =>
  new FileSnapshot('a\nb\nc', '\n', makeFile(path));

/**
 * A live snapshot whose current state diverges from its history origin. Only the
 * state is moved (not the marker baseline), so the divergence is measured
 * against the persisted origin, the whole-history scope this helper reports on.
 */
const makeModified = (path: string = 'a.md'): FileSnapshot => {
  const snapshot: FileSnapshot = makeClean(path);
  snapshot.content.updateState(['a', 'B', 'c']);

  return snapshot;
};

describe('VaultChangesHelper.statusOf', () => {
  it('returns deleted for a tombstoned snapshot', () => {
    const snapshot: FileSnapshot = makeClean();
    snapshot.deletedTimestamp = 1_000;

    expect(VaultChangesHelper.statusOf(snapshot)).toBe(FolderDeltaStatus.deleted);
  });

  it('returns added for a snapshot flagged created this session', () => {
    const snapshot: FileSnapshot = makeClean();
    snapshot.createdThisSession = true;

    expect(VaultChangesHelper.statusOf(snapshot)).toBe(FolderDeltaStatus.added);
  });

  it('returns added for a file born blank under tracking that now has content', () => {
    const snapshot: FileSnapshot = new FileSnapshot('', '\n', makeFile('new.md'));
    snapshot.content.updateState(['hello world']);

    expect(VaultChangesHelper.statusOf(snapshot)).toBe(FolderDeltaStatus.added);
  });

  it('returns modified when the current content diverges from the history origin', () => {
    expect(VaultChangesHelper.statusOf(makeModified())).toBe(FolderDeltaStatus.modified);
  });

  it('reports modified against the history origin even when the marker baseline is session-clean', () => {
    // Models a restored file: adopt a different persisted origin, then reset the
    // marker baseline onto the current state so the SESSION view reads none. The
    // whole-history view must still see the divergence from the persisted origin.
    const snapshot: FileSnapshot = makeClean();
    snapshot.adoptHistory(['different origin'], []);
    snapshot.resetMarkerBaseline();

    expect(snapshot.content.getChangesLinesCount()).toBe(0);
    expect(VaultChangesHelper.statusOf(snapshot)).toBe(FolderDeltaStatus.modified);
  });

  it('returns none for a snapshot unchanged since its origin', () => {
    expect(VaultChangesHelper.statusOf(makeClean())).toBe(FolderDeltaStatus.none);
  });

  it('prefers deleted over added for a tombstone created this session', () => {
    const snapshot: FileSnapshot = makeClean();
    snapshot.createdThisSession = true;
    snapshot.deletedTimestamp = 2_000;

    expect(VaultChangesHelper.statusOf(snapshot)).toBe(FolderDeltaStatus.deleted);
  });
});

describe('VaultChangesHelper.collectEntries', () => {
  it('maps changed snapshots to entries and drops unchanged ones', () => {
    const entries = VaultChangesHelper.collectEntries([
      makeClean('unchanged.md'),
      makeModified('changed.md'),
    ]);

    expect(entries).toEqual([
      { path: 'changed.md', status: FolderDeltaStatus.modified, external: false },
    ]);
  });

  it('resolves the path from the carried path when the live file is gone', () => {
    const snapshot: FileSnapshot = makeModified('kept.md');
    snapshot.file = null;
    snapshot.path = 'kept.md';

    const entries = VaultChangesHelper.collectEntries([snapshot]);

    expect(entries.map((entry) => entry.path)).toEqual(['kept.md']);
  });

  it('skips a snapshot with no resolvable path', () => {
    const snapshot: FileSnapshot = makeModified('x.md');
    snapshot.file = null;
    snapshot.path = '';

    expect(VaultChangesHelper.collectEntries([snapshot])).toEqual([]);
  });

  it('honours the include predicate to drop hidden paths', () => {
    const entries = VaultChangesHelper.collectEntries(
      [makeModified('visible.md'), makeModified('hidden.md')],
      (path: string): boolean => path !== 'hidden.md',
    );

    expect(entries.map((entry) => entry.path)).toEqual(['visible.md']);
  });

  it('carries a deleted tombstone through as an entry', () => {
    const snapshot: FileSnapshot = makeClean('gone.md');
    snapshot.deletedTimestamp = 5_000;

    const entries = VaultChangesHelper.collectEntries([snapshot]);

    expect(entries).toEqual([
      { path: 'gone.md', status: FolderDeltaStatus.deleted, external: false },
    ]);
  });
});
