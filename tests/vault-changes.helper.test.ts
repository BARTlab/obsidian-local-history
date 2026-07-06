import { describe, expect, it } from 'vitest';

import { FolderDeltaStatus, KeepHistory } from '@/consts';
import * as VaultChangesHelper from '@/helpers/vault-changes.helper';
import { resolveOrigin } from '@/helpers/origin.helper';
import { FileSnapshot } from '@/snapshots/file.snapshot';
import { FileVersion } from '@/snapshots/file.version';

import { makeFile } from './helpers/builders';

/** A clean live snapshot whose current content still equals its origin. */
const makeClean = (path: string = 'a.md'): FileSnapshot =>
  new FileSnapshot('a\nb\nc', '\n', makeFile(path));

/**
 * A live snapshot whose current state diverges from its origin. Only the state
 * is moved (not the marker/history baseline), so the divergence is measured
 * against whatever origin the caller resolves.
 */
const makeModified = (path: string = 'a.md'): FileSnapshot => {
  const snapshot: FileSnapshot = makeClean(path);
  snapshot.content.updateState(['a', 'B', 'c']);

  return snapshot;
};

/** Binds a keep level into the per-snapshot resolver the panel passes in. */
const originFor =
  (keep: KeepHistory) =>
  (snapshot: FileSnapshot): string[] =>
    resolveOrigin(snapshot, keep);

describe('VaultChangesHelper.statusOf', () => {
  it('returns deleted for a tombstoned snapshot regardless of the origin', () => {
    const snapshot: FileSnapshot = makeClean();
    snapshot.deletedTimestamp = 1_000;

    expect(VaultChangesHelper.statusOf(snapshot, ['whatever'])).toBe(FolderDeltaStatus.deleted);
  });

  it('returns added for a snapshot flagged created this session', () => {
    const snapshot: FileSnapshot = makeClean();
    snapshot.createdThisSession = true;

    expect(VaultChangesHelper.statusOf(snapshot, ['a', 'b', 'c'])).toBe(FolderDeltaStatus.added);
  });

  it('returns added for a file born blank under tracking that now has content', () => {
    const snapshot: FileSnapshot = new FileSnapshot('', '\n', makeFile('new.md'));
    snapshot.content.updateState(['hello world']);

    expect(VaultChangesHelper.statusOf(snapshot, [''])).toBe(FolderDeltaStatus.added);
  });

  it('returns modified when the current content diverges from the supplied origin', () => {
    expect(VaultChangesHelper.statusOf(makeModified(), ['a', 'b', 'c'])).toBe(FolderDeltaStatus.modified);
  });

  it('diffs against the supplied origin, not the marker baseline', () => {
    // Models a restored file whose marker baseline was collapsed onto the
    // current state (session view reads none). The panel must still see the
    // divergence when the caller resolves an OLDER origin.
    const snapshot: FileSnapshot = makeClean();
    snapshot.resetMarkerBaseline();

    expect(snapshot.content.getChangesLinesCount()).toBe(0);
    expect(VaultChangesHelper.statusOf(snapshot, ['different origin'])).toBe(FolderDeltaStatus.modified);
  });

  it('returns none for a snapshot unchanged since the supplied origin', () => {
    expect(VaultChangesHelper.statusOf(makeClean(), ['a', 'b', 'c'])).toBe(FolderDeltaStatus.none);
  });

  it('prefers deleted over added for a tombstone created this session', () => {
    const snapshot: FileSnapshot = makeClean();
    snapshot.createdThisSession = true;
    snapshot.deletedTimestamp = 2_000;

    expect(VaultChangesHelper.statusOf(snapshot, ['a', 'b', 'c'])).toBe(FolderDeltaStatus.deleted);
  });
});

describe('VaultChangesHelper.collectEntries', () => {
  it('maps changed snapshots to entries and drops unchanged ones', () => {
    const entries = VaultChangesHelper.collectEntries(
      [makeClean('unchanged.md'), makeModified('changed.md')],
      originFor(KeepHistory.app),
    );

    expect(entries).toEqual([
      expect.objectContaining({ path: 'changed.md', status: FolderDeltaStatus.modified, external: false }),
    ]);
    // Each entry now carries the file's last-changed datetime for the row tooltip.
    expect(typeof entries[0].date).toBe('string');
  });

  it('resolves the path from the carried path when the live file is gone', () => {
    const snapshot: FileSnapshot = makeModified('kept.md');
    snapshot.file = null;
    snapshot.path = 'kept.md';

    const entries = VaultChangesHelper.collectEntries([snapshot], originFor(KeepHistory.app));

    expect(entries.map((entry) => entry.path)).toEqual(['kept.md']);
  });

  it('skips a snapshot with no resolvable path', () => {
    const snapshot: FileSnapshot = makeModified('x.md');
    snapshot.file = null;
    snapshot.path = '';

    expect(VaultChangesHelper.collectEntries([snapshot], originFor(KeepHistory.app))).toEqual([]);
  });

  it('honours the include predicate to drop hidden paths', () => {
    const entries = VaultChangesHelper.collectEntries(
      [makeModified('visible.md'), makeModified('hidden.md')],
      originFor(KeepHistory.app),
      (path: string): boolean => path !== 'hidden.md',
    );

    expect(entries.map((entry) => entry.path)).toEqual(['visible.md']);
  });

  it('carries a deleted tombstone through as an entry regardless of the resolver', () => {
    const snapshot: FileSnapshot = makeClean('gone.md');
    snapshot.deletedTimestamp = 5_000;

    const entries = VaultChangesHelper.collectEntries([snapshot], originFor(KeepHistory.persist));

    expect(entries).toEqual([
      expect.objectContaining({ path: 'gone.md', status: FolderDeltaStatus.deleted, external: false }),
    ]);
    expect(typeof entries[0].date).toBe('string');
  });
});

/**
 * These exercise the agreement the task exists to close: the panel diffs against
 * the SAME origin `resolveOrigin` feeds the change map (and therefore the tree),
 * so both surfaces list identical sets at every keep level.
 */
describe('VaultChangesHelper.collectEntries agrees with the resolved origin', () => {
  /**
   * A restored file whose current state equals its sliding origin (the oldest
   * retained version) but still differs from the full history baseline: its only
   * change predates the sliding origin.
   */
  const makeSlidPastOrigin = (path: string): FileSnapshot => {
    const snapshot: FileSnapshot = new FileSnapshot('v1', '\n', makeFile(path));
    snapshot.adoptHistory(['v0'], [new FileVersion(['v1'])]);

    return snapshot;
  };

  /** A restored file whose current state still differs from the sliding origin. */
  const makeStillDiverged = (path: string): FileSnapshot => {
    const snapshot: FileSnapshot = new FileSnapshot('v2', '\n', makeFile(path));
    snapshot.adoptHistory(['v0'], [new FileVersion(['v1'])]);

    return snapshot;
  };

  it('at keep=persist lists only files still diverged from the sliding origin (bounded)', () => {
    const entries = VaultChangesHelper.collectEntries(
      [makeSlidPastOrigin('predates.md'), makeStillDiverged('recent.md')],
      originFor(KeepHistory.persist),
    );

    // 'predates.md' changed only before the sliding origin, so it drops off the
    // panel exactly as it drops off the tree; 'recent.md' still differs, so it stays.
    expect(entries.map((entry) => entry.path)).toEqual(['recent.md']);
  });

  it('at keep=app shows the session-scoped set, hiding a session-clean restored file', () => {
    // Marker baseline collapsed onto current (session-clean) but history diverges.
    const restored: FileSnapshot = makeClean('restored.md');
    restored.adoptHistory(['different origin'], []);
    restored.resetMarkerBaseline();

    const entries = VaultChangesHelper.collectEntries(
      [restored, makeModified('edited.md')],
      originFor(KeepHistory.app),
    );

    // The session view (marker baseline) reads the restored file as clean, so the
    // panel hides it, matching the gutter and tree; only the live edit shows.
    expect(entries.map((entry) => entry.path)).toEqual(['edited.md']);
  });
});
