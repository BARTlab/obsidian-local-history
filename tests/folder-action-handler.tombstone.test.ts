import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock, type MockInstance } from 'vitest';

import { FolderActionHandler } from '@/modals/folder-action-handler';
import type { FolderActionHost } from '@/modals/folder-action-handler.types';
import { FolderDeltaStatus } from '@/consts';
import { FileSnapshot } from '@/snapshots/file.snapshot';
import * as obsidian from 'obsidian';
import type { FolderDeltaResult } from '@/types';
import type { TFile } from 'obsidian';

/**
 * Covers the tombstone-restore disk branches of {@link FolderActionHandler}
 * (path occupied / free / vault.create throws), driven through the public
 * `handleRestoreSelected` entry point. The dispatch that routes a
 * tombstone-deleted selection into this path is asserted in
 * folder-action-handler.test.ts; here the branches themselves are exercised
 * end to end so no protected method is reached off the prototype.
 */

const OLD_PATH = 'old.md';

const result: FolderDeltaResult = {
  status: FolderDeltaStatus.deleted,
  base: ['hello', 'world'],
  current: [],
};

/**
 * Builds a tombstone-shaped snapshot via the public {@link FileSnapshot} API at
 * {@link OLD_PATH}. The captured content is irrelevant to the disk branches
 * (they write `result.base`); only the tombstone marker and the line break the
 * restore joins on matter.
 *
 * @return {FileSnapshot} A tombstone snapshot with a `\n` line break
 */
function buildTombstone(): FileSnapshot {
  const snapshot = new FileSnapshot('old', '\n');

  snapshot.deletedTimestamp = 1;

  return snapshot;
}

/**
 * Builds a {@link FolderActionHost} whose only live collaborators are the ones
 * the tombstone-restore path touches: the vault (its `getAbstractFileByPath`
 * and `create` stubs decide which branch runs), the translation resolver, the
 * confirm dialog (auto-approved so the public handler reaches the tombstone
 * branch), and the snapshots-service `forceUpdate` spy. The re-render callbacks
 * are stubbed so the handler can complete after the branch runs.
 *
 * @param {object} vault - Vault stub with `getAbstractFileByPath` and `create`
 * @param {Mock} forceUpdate - Spy for `snapshotsService.forceUpdate`
 * @param {FileSnapshot} snapshot - The tombstone snapshot to restore
 * @return {FolderActionHost} The focused host
 */
function makeHost(
  vault: { getAbstractFileByPath: Mock; create: Mock },
  forceUpdate: Mock,
  snapshot: FileSnapshot,
): FolderActionHost {
  return {
    app: { vault },
    plugin: { t: (key: string): string => key },
    modalsService: { confirm: (): Promise<boolean> => Promise.resolve(true) },
    snapshotsService: { forceUpdate },
    resolveSelection: () => ({ path: OLD_PATH, snapshot, result }),
    resyncTimeline: vi.fn(),
    refreshTree: vi.fn(),
    refreshDiff: vi.fn(),
  } as unknown as FolderActionHost;
}

describe('FolderActionHandler tombstone restore (disk branches)', () => {
  let notice: MockInstance<typeof obsidian.Notice>;

  beforeEach(() => {
    notice = vi.spyOn(obsidian, 'Notice').mockImplementation(
      (function(this: unknown): void {
        // Inert: record the construction without standing up a real toast.
      }) as unknown as (message?: string | DocumentFragment) => obsidian.Notice,
    );
  });

  afterEach(() => {
    notice.mockRestore();
  });

  it('surfaces the distinct notice and skips create when the path is occupied', async () => {
    const getAbstractFileByPath = vi.fn().mockReturnValue({ path: OLD_PATH });
    const create = vi.fn();
    const forceUpdate = vi.fn();
    const host = makeHost({ getAbstractFileByPath, create }, forceUpdate, buildTombstone());

    await new FolderActionHandler(host).handleRestoreSelected();

    expect(getAbstractFileByPath).toHaveBeenCalledWith(OLD_PATH);
    expect(create).not.toHaveBeenCalled();
    expect(forceUpdate).not.toHaveBeenCalled();
    expect(notice).toHaveBeenCalledWith('notice.file-restore-path-occupied');
  });

  it('recreates the file and promotes the snapshot when the old path is free', async () => {
    const recreated = { path: OLD_PATH } as unknown as TFile;
    const getAbstractFileByPath = vi.fn().mockReturnValue(null);
    const create = vi.fn(
      (_path: string, _content: string): Promise<unknown> => Promise.resolve(recreated),
    );

    const forceUpdate = vi.fn();
    const snapshot = buildTombstone();
    const host = makeHost(
      { getAbstractFileByPath, create: create as unknown as Mock },
      forceUpdate,
      snapshot,
    );

    await new FolderActionHandler(host).handleRestoreSelected();

    expect(getAbstractFileByPath).toHaveBeenCalledWith(OLD_PATH);
    expect(create).toHaveBeenCalledWith(OLD_PATH, 'hello\nworld');
    expect(snapshot.file).toBe(recreated);
    expect(snapshot.deletedTimestamp).toBeUndefined();
    expect(forceUpdate).toHaveBeenCalledTimes(1);
  });

  it('falls back to the generic notice when create throws on a free path', async () => {
    const getAbstractFileByPath = vi.fn().mockReturnValue(null);
    const create = vi.fn(
      (_path: string, _content: string): Promise<unknown> => Promise.reject(new Error('boom')),
    );

    const forceUpdate = vi.fn();
    const host = makeHost(
      { getAbstractFileByPath, create: create as unknown as Mock },
      forceUpdate,
      buildTombstone(),
    );

    await new FolderActionHandler(host).handleRestoreSelected();

    expect(create).toHaveBeenCalledTimes(1);
    expect(forceUpdate).not.toHaveBeenCalled();
    expect(notice).toHaveBeenCalledWith('notice.file-restore-failed');
  });
});
