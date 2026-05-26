/**
 * @jest-environment jsdom
 */

import 'reflect-metadata';
import { describe, expect, it, jest } from '@jest/globals';

import { FolderHistoryModal } from '@/modals/folder-history.modal';
import { FolderDeltaStatus } from '@/consts';
import { FileSnapshot } from '@/snapshots/file.snapshot';
import type { FolderDeltaResult } from '@/types';

/**
 * Guards `restoreTombstoneSelection` (T14) against an occupied target path. The
 * production method is protected and the modal class drags the whole DI / DOM
 * lifecycle through its constructor, so the test bypasses construction via
 * `Object.create` and assigns only the fields the method actually touches:
 * `app.vault`, `plugin.t`, `snapshotsService`. This keeps the test focused on
 * the new occupied-path branch without standing up the full modal.
 */

type RestoreFn = (path: string, snapshot: FileSnapshot, result: FolderDeltaResult) => Promise<void>;

/**
 * Builds a minimally-wired `FolderHistoryModal` instance: only the collaborators
 * `restoreTombstoneSelection` reads are populated, everything else is left
 * undefined. The bound restore function is returned so the test can call the
 * protected method without a cast at every call site.
 *
 * `snapshotsService` is wired through `plugin.get` because the `@Inject`
 * decorator installs a setter that throws on direct assignment; the test
 * cooperates with the DI getter instead of fighting it.
 *
 * @param {object} vault - Vault stub with `getAbstractFileByPath` and `create`
 * @param {(key: string) => string} t - i18n resolver stub (returns the key itself)
 * @param {jest.Mock} forceUpdate - Spy for `snapshotsService.forceUpdate`
 * @return {RestoreFn} A bound reference to the protected restoreTombstoneSelection
 */
function buildModal(
  vault: { getAbstractFileByPath: jest.Mock; create: jest.Mock },
  t: (key: string) => string,
  forceUpdate: jest.Mock,
): RestoreFn {
  const instance = Object.create(FolderHistoryModal.prototype) as Record<string, unknown>;
  const snapshotsService = { forceUpdate };
  const plugin = {
    t,
    get(name: string): unknown {
      if (name === 'SnapshotsService') {
        return snapshotsService;
      }

      return undefined;
    },
  };

  instance.app = { vault };
  instance.plugin = plugin;

  const proto = FolderHistoryModal.prototype as unknown as Record<string, RestoreFn>;
  const restoreFn = proto.restoreTombstoneSelection;

  return restoreFn.bind(instance as unknown as FolderHistoryModal);
}

/**
 * Builds a tombstone-shaped snapshot via the public `FileSnapshot` API (the
 * marker bits are state-only, so a freshly-flagged snapshot is enough for this
 * test). The captured state and changes are irrelevant to the occupied-path
 * branch but are touched on the free-path branch.
 *
 * @return {FileSnapshot} A tombstone snapshot at path `old.md`
 */
function buildTombstone(): FileSnapshot {
  const snapshot = new FileSnapshot('old.md');

  snapshot.lineBreak = '\n';
  snapshot.deletedTimestamp = 1;

  return snapshot;
}

describe('FolderHistoryModal.restoreTombstoneSelection (T14 occupied-path guard)', () => {
  const result: FolderDeltaResult = {
    status: FolderDeltaStatus.deleted,
    base: ['hello', 'world'],
    current: [],
  };

  it('surfaces the distinct notice and skips create when the path is occupied', async () => {
    const getAbstractFileByPath = jest.fn().mockReturnValue({ path: 'old.md' });
    const create = jest.fn();
    const forceUpdate = jest.fn();
    const keys: string[] = [];
    const t = (key: string): string => {
      keys.push(key);

      return key;
    };

    const restore = buildModal({ getAbstractFileByPath, create }, t, forceUpdate);

    await restore('old.md', buildTombstone(), result);

    expect(getAbstractFileByPath).toHaveBeenCalledWith('old.md');
    expect(create).not.toHaveBeenCalled();
    expect(forceUpdate).not.toHaveBeenCalled();
    expect(keys).toEqual(['notice.file-restore-path-occupied']);
  });

  it('still recreates the file when the old path is free', async () => {
    const recreated = { path: 'old.md' };
    const getAbstractFileByPath = jest.fn().mockReturnValue(null);
    const create = jest.fn((_path: string, _content: string): Promise<unknown> => Promise.resolve(recreated));
    const forceUpdate = jest.fn();
    const t = (key: string): string => key;

    const restore = buildModal(
      { getAbstractFileByPath, create: create as unknown as jest.Mock },
      t,
      forceUpdate,
    );

    const snapshot = buildTombstone();

    await restore('old.md', snapshot, result);

    expect(getAbstractFileByPath).toHaveBeenCalledWith('old.md');
    expect(create).toHaveBeenCalledWith('old.md', 'hello\nworld');
    expect(snapshot.file).toBe(recreated);
    expect(snapshot.deletedTimestamp).toBeUndefined();
    expect(forceUpdate).toHaveBeenCalledTimes(1);
  });

  it('falls back to the generic notice when create throws on a free path', async () => {
    const getAbstractFileByPath = jest.fn().mockReturnValue(null);
    const create = jest.fn((_path: string, _content: string): Promise<unknown> => {
      return Promise.reject(new Error('boom'));
    });
    const forceUpdate = jest.fn();
    const keys: string[] = [];
    const t = (key: string): string => {
      keys.push(key);

      return key;
    };

    const restore = buildModal(
      { getAbstractFileByPath, create: create as unknown as jest.Mock },
      t,
      forceUpdate,
    );

    await restore('old.md', buildTombstone(), result);

    expect(create).toHaveBeenCalledTimes(1);
    expect(forceUpdate).not.toHaveBeenCalled();
    expect(keys).toEqual(['notice.file-restore-failed']);
  });

});
