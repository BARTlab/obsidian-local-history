import 'reflect-metadata';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { FolderDeltaStatus } from '@/consts';
import { FolderActionHandler } from '@/modals/folder-action-handler';
import type { FolderActionHost, FolderActionSelection } from '@/modals/folder-action-handler';
import { FileSnapshot } from '@/snapshots/file.snapshot';
import { FileVersion } from '@/snapshots/file.version';
import type LineChangeTrackerPlugin from '@/main';
import type { ModalsService } from '@/services/modals.service';
import type { SnapshotsService } from '@/services/snapshots.service';
import type { VersionActionsService } from '@/services/version-actions.service';
import type { FolderDeltaResult } from '@/types';
import type { App, TFile } from 'obsidian';

import { makeFile } from './helpers/builders';

/**
 * Tests for {@link FolderActionHandler}, the toolbar-action collaborator
 * the folder-history modal owns. Extracted from the 1416-LOC modal, where the
 * five async actions were tangled with the rendering; these cover the dispatch
 * behaviour each action relies on:
 *
 * - every action early-exits on a null selection,
 * - restore-selected restores the version closest to T on a live file, routes a
 *   tombstone-deleted selection to the tombstone-restore path, and re-renders,
 * - remove-selected drops the version closest to T (a no-op without one),
 * - label-selected routes through the modals service and re-renders only on a
 *   non-blank label,
 * - restore-original writes the baseline, wipes the snapshot, and drops it from
 *   the map, and
 * - remove-history wipes the snapshot for a live file and is a no-op for a
 *   tombstone, and every destructive action respects a declined confirm.
 *
 * The tombstone-restore disk branches (occupied / free / throw) are covered in
 * folder-history.modal.tombstone.test.ts; here the restore-selected dispatch is
 * asserted to reach that path, not its internals.
 *
 * Real {@link FileSnapshot} / {@link FileVersion} instances back the selection so
 * the tombstone and version checks run against the genuine API.
 */
describe('FolderActionHandler', () => {
  let selection: FolderActionSelection | null;
  let versionAtT: FileVersion | null;
  let confirmResult: boolean;
  let labelResult: FileVersion | null;

  let confirm: jest.Mock<() => Promise<boolean>>;
  let restoreSelected: jest.Mock<(file: TFile, id: string) => Promise<void>>;
  let removeSelected: jest.Mock<(file: TFile, id: string) => void>;
  let labelVersion: jest.Mock<() => Promise<FileVersion | null>>;
  let applyContent: jest.Mock<(...args: unknown[]) => Promise<boolean>>;
  let wipeOne: jest.Mock<(file: TFile) => void>;
  let forceUpdate: jest.Mock<() => void>;
  let modify: jest.Mock<(file: TFile, content: string) => Promise<void>>;
  let removeFromMap: jest.Mock<(path: string) => void>;
  let resyncTimeline: jest.Mock<() => void>;
  let refreshTree: jest.Mock<() => void>;
  let refreshDiff: jest.Mock<() => void>;

  const plugin = {
    t: (key: string): string => key,
  } as unknown as LineChangeTrackerPlugin;

  const makeHost = (): FolderActionHost => ({
    app: {
      vault: {
        getAbstractFileByPath: (): null => null,
        create: (): Promise<unknown> => Promise.resolve({ path: 'x' }),
        modify: (file: TFile, content: string): Promise<void> => modify(file, content),
      },
    } as unknown as App,
    plugin,
    modalsService: {
      confirm: (): Promise<boolean> => confirm(),
      labelVersion: (): Promise<FileVersion | null> => labelVersion(),
    } as unknown as ModalsService,
    versionActionsService: {
      restoreSelected: (file: TFile, id: string): Promise<void> => restoreSelected(file, id),
      removeSelected: (file: TFile, id: string): void => removeSelected(file, id),
    } as unknown as VersionActionsService,
    snapshotsService: {
      applyContent: (file: TFile, lines: string[], block: unknown): Promise<boolean> =>
        applyContent(file, lines, block),
      wipeOne: (file: TFile): void => wipeOne(file),
      forceUpdate: (): void => forceUpdate(),
    } as unknown as SnapshotsService,
    resolveSelection: (): FolderActionSelection | null => selection,
    resolveVersionAtT: (): FileVersion | null => versionAtT,
    removeFromMap: (path: string): void => removeFromMap(path),
    resyncTimeline: (): void => resyncTimeline(),
    refreshTree: (): void => refreshTree(),
    refreshDiff: (): void => refreshDiff(),
  });

  /**
   * Builds a live (non-tombstone) selection at `a.md` whose snapshot carries the
   * given base / current content, with status `modified`.
   *
   * @param {string} base - The history baseline content
   * @param {string} current - The live content
   * @return {FolderActionSelection} The selection
   */
  const liveSelection = (base: string = 'one', current: string = 'one-changed'): FolderActionSelection => {
    const snapshot = new FileSnapshot(base);

    snapshot.content.updateState(current.split('\n'));
    snapshot.file = makeFile('a.md');

    const result: FolderDeltaResult = {
      status: FolderDeltaStatus.modified,
      base: base.split('\n'),
      current: current.split('\n'),
    };

    return { path: 'a.md', snapshot, result };
  };

  beforeEach((): void => {
    selection = null;
    versionAtT = null;
    confirmResult = true;
    labelResult = null;
    confirm = jest.fn(() => Promise.resolve(confirmResult));
    restoreSelected = jest.fn();
    removeSelected = jest.fn();
    labelVersion = jest.fn(() => Promise.resolve(labelResult));
    applyContent = jest.fn(() => Promise.resolve(true));
    wipeOne = jest.fn();
    forceUpdate = jest.fn();
    modify = jest.fn(() => Promise.resolve());
    removeFromMap = jest.fn();
    resyncTimeline = jest.fn();
    refreshTree = jest.fn();
    refreshDiff = jest.fn();
  });

  describe('handleRestoreSelected', () => {
    it('is a no-op when nothing is selected', async () => {
      selection = null;
      await new FolderActionHandler(makeHost()).handleRestoreSelected();

      expect(restoreSelected).not.toHaveBeenCalled();
      expect(refreshTree).not.toHaveBeenCalled();
    });

    it('does not restore when the confirm is declined', async () => {
      selection = liveSelection();
      versionAtT = new FileVersion(['one'], 1);
      confirmResult = false;

      await new FolderActionHandler(makeHost()).handleRestoreSelected();

      expect(restoreSelected).not.toHaveBeenCalled();
    });

    it('restores the version closest to T on a live file and re-renders', async () => {
      selection = liveSelection();
      versionAtT = new FileVersion(['one'], 1);

      await new FolderActionHandler(makeHost()).handleRestoreSelected();

      expect(restoreSelected).toHaveBeenCalledTimes(1);
      expect(restoreSelected).toHaveBeenCalledWith(selection!.snapshot.file!, versionAtT.id);
      expect(refreshTree).toHaveBeenCalledTimes(1);
      expect(refreshDiff).toHaveBeenCalledTimes(1);
    });

    it('writes the synthetic baseline through applyContent when T precedes every version', async () => {
      selection = liveSelection('base-line', 'live-line');
      versionAtT = null;

      await new FolderActionHandler(makeHost()).handleRestoreSelected();

      expect(restoreSelected).not.toHaveBeenCalled();
      expect(applyContent).toHaveBeenCalledTimes(1);
      const [, baseLines] = applyContent.mock.calls[0] as [TFile, string[], unknown];

      expect(baseLines).toEqual(['base-line']);
    });

    it('routes a tombstone-deleted selection to the tombstone-restore path', async () => {
      const snapshot = new FileSnapshot('old');

      snapshot.deletedTimestamp = 1;
      expect(snapshot.isTombstone()).toBe(true);
      const result: FolderDeltaResult = { status: FolderDeltaStatus.deleted, base: ['old'], current: [] };

      selection = { path: 'a.md', snapshot, result };

      await new FolderActionHandler(makeHost()).handleRestoreSelected();

      // The tombstone branch recreates the file on disk (vault.create), promotes
      // the snapshot, then re-renders. It does not go through the live-file
      // restore service.
      expect(restoreSelected).not.toHaveBeenCalled();
      expect(snapshot.deletedTimestamp).toBeUndefined();
      expect(resyncTimeline).toHaveBeenCalledTimes(1);
      expect(refreshTree).toHaveBeenCalledTimes(1);
    });
  });

  describe('handleRemoveSelected', () => {
    it('is a no-op without a version closest to T', async () => {
      selection = liveSelection();
      versionAtT = null;

      await new FolderActionHandler(makeHost()).handleRemoveSelected();

      expect(removeSelected).not.toHaveBeenCalled();
      expect(resyncTimeline).not.toHaveBeenCalled();
    });

    it('removes the version closest to T after a confirm and re-renders', async () => {
      selection = liveSelection();
      versionAtT = new FileVersion(['one'], 1);

      await new FolderActionHandler(makeHost()).handleRemoveSelected();

      expect(removeSelected).toHaveBeenCalledWith(selection!.snapshot.file!, versionAtT.id);
      expect(resyncTimeline).toHaveBeenCalledTimes(1);
      expect(refreshTree).toHaveBeenCalledTimes(1);
      expect(refreshDiff).toHaveBeenCalledTimes(1);
    });

    it('does not remove when the confirm is declined', async () => {
      selection = liveSelection();
      versionAtT = new FileVersion(['one'], 1);
      confirmResult = false;

      await new FolderActionHandler(makeHost()).handleRemoveSelected();

      expect(removeSelected).not.toHaveBeenCalled();
    });
  });

  describe('handleLabelSelected', () => {
    it('re-renders only when the modals service returns a labeled version', async () => {
      selection = liveSelection();
      versionAtT = new FileVersion(['one'], 1);
      labelResult = versionAtT;

      await new FolderActionHandler(makeHost()).handleLabelSelected();

      expect(refreshTree).toHaveBeenCalledTimes(1);
      expect(refreshDiff).toHaveBeenCalledTimes(1);
    });

    it('is a no-op when the label is blank / cancelled', async () => {
      selection = liveSelection();
      versionAtT = new FileVersion(['one'], 1);
      labelResult = null;

      await new FolderActionHandler(makeHost()).handleLabelSelected();

      expect(refreshTree).not.toHaveBeenCalled();
    });
  });

  describe('handleRestoreOriginal', () => {
    it('writes the baseline, wipes the snapshot, drops it from the map and re-renders', async () => {
      selection = liveSelection('original', 'changed');

      await new FolderActionHandler(makeHost()).handleRestoreOriginal();

      expect(modify).toHaveBeenCalledTimes(1);
      expect(wipeOne).toHaveBeenCalledWith(selection!.snapshot.file!);
      expect(removeFromMap).toHaveBeenCalledWith('a.md');
      expect(resyncTimeline).toHaveBeenCalledTimes(1);
    });

    it('does not wipe when the confirm is declined', async () => {
      selection = liveSelection();
      confirmResult = false;

      await new FolderActionHandler(makeHost()).handleRestoreOriginal();

      expect(modify).not.toHaveBeenCalled();
      expect(wipeOne).not.toHaveBeenCalled();
    });
  });

  describe('handleRemoveHistory', () => {
    it('wipes the snapshot for a live file and re-renders', async () => {
      selection = liveSelection();

      await new FolderActionHandler(makeHost()).handleRemoveHistory();

      expect(wipeOne).toHaveBeenCalledWith(selection!.snapshot.file!);
      expect(removeFromMap).toHaveBeenCalledWith('a.md');
      expect(resyncTimeline).toHaveBeenCalledTimes(1);
    });

    it('is a no-op for a tombstone selection (no live file)', async () => {
      const snapshot = new FileSnapshot('old');

      snapshot.deletedTimestamp = 1;
      selection = { path: 'a.md', snapshot, result: { status: FolderDeltaStatus.deleted, base: [], current: [] } };

      await new FolderActionHandler(makeHost()).handleRemoveHistory();

      expect(wipeOne).not.toHaveBeenCalled();
    });
  });
});
