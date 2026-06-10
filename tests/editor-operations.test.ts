import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { EditorOperations } from '@/snapshots/editor-operations';
import type { EditorOperationsHost } from '@/snapshots/editor-operations';
import { FileSnapshot } from '@/snapshots/file.snapshot';
import type LineChangeTrackerPlugin from '@/main';
import type { TFile } from 'obsidian';

import { makeFile } from './helpers/builders';

/**
 * Tests for {@link EditorOperations} (T12), the out-of-editor file-write
 * collaborator the snapshots service owns. Extracted from the 1103-LOC service,
 * where the single `applyContent` write path was tangled with the snapshot CRUD;
 * these cover the behaviour the per-hunk revert relies on:
 *
 * - applyContent rewrites the changed block in the tracker, sets the cached
 *   state to the written content, writes the joined lines to disk via
 *   `vault.modify`, and notifies subscribers through the host's `forceUpdate`,
 * - the editor is force-refreshed only when an active markdown view exists, and
 * - a missing file, missing snapshot, or non-array lines is a no-op that returns
 *   false and never touches disk.
 *
 * A real {@link FileSnapshot} backs the host so the block rewrite and state sync
 * run against the genuine tracker rather than a mock that could drift from it.
 */
describe('EditorOperations', () => {
  let snapshot: FileSnapshot | null;
  let file: TFile | null;
  let modify: jest.Mock<(target: TFile, content: string) => Promise<void>>;
  let forceUpdate: jest.Mock;
  let forceUpdateEditor: jest.Mock;
  let activeView: unknown;

  const makeHost = (): EditorOperationsHost => {
    const plugin = {
      app: {
        vault: {
          modify: (target: TFile, content: string): Promise<void> => modify(target, content),
        },
      },
      getActiveViewOfType: (): unknown => activeView,
      forceUpdateEditor: (): void => {
        forceUpdateEditor();
      },
    } as unknown as LineChangeTrackerPlugin;

    return {
      plugin,
      getSnapshot: (): FileSnapshot | null => snapshot,
      forceUpdate: (): void => {
        forceUpdate();
      },
    };
  };

  beforeEach((): void => {
    file = makeFile('note.md');
    snapshot = new FileSnapshot('a\nb\nc');
    snapshot.file = file;
    modify = jest.fn(() => Promise.resolve());
    forceUpdate = jest.fn();
    forceUpdateEditor = jest.fn();
    // No active markdown view by default; an editor-bound test opts in.
    activeView = null;
  });

  it('rewrites the block, syncs the cached state, writes to disk and notifies subscribers', async () => {
    const lines: string[] = ['a', 'B', 'c'];
    const ops = new EditorOperations(makeHost());

    const applied: boolean = await ops.applyContent(file, lines, { start: 1, removeCount: 1, newLines: ['B'] });

    expect(applied).toBe(true);
    // The cached state mirrors the written content so a later read sees the new
    // baseline.
    expect((snapshot as FileSnapshot).getLastStateLines()).toEqual(['a', 'B', 'c']);
    // The disk write joins on the snapshot's line break.
    expect(modify).toHaveBeenCalledTimes(1);
    expect(modify).toHaveBeenCalledWith(file, 'a\nB\nc');
    expect(forceUpdate).toHaveBeenCalledTimes(1);
  });

  it('refreshes the editor only when an active markdown view exists', async () => {
    activeView = {};
    const ops = new EditorOperations(makeHost());

    await ops.applyContent(file, ['a', 'B', 'c'], { start: 1, removeCount: 1, newLines: ['B'] });

    expect(forceUpdateEditor).toHaveBeenCalledTimes(1);
  });

  it('does not refresh the editor when there is no active markdown view', async () => {
    activeView = null;
    const ops = new EditorOperations(makeHost());

    await ops.applyContent(file, ['a', 'B', 'c'], { start: 1, removeCount: 1, newLines: ['B'] });

    expect(forceUpdateEditor).not.toHaveBeenCalled();
  });

  it('is a no-op returning false when the file is null', async () => {
    file = null;
    const ops = new EditorOperations(makeHost());

    const applied: boolean = await ops.applyContent(null, ['a'], { start: 0, removeCount: 0, newLines: ['a'] });

    expect(applied).toBe(false);
    expect(modify).not.toHaveBeenCalled();
    expect(forceUpdate).not.toHaveBeenCalled();
  });

  it('is a no-op returning false when the snapshot is missing', async () => {
    snapshot = null;
    const ops = new EditorOperations(makeHost());

    const applied: boolean = await ops.applyContent(file, ['a'], { start: 0, removeCount: 0, newLines: ['a'] });

    expect(applied).toBe(false);
    expect(modify).not.toHaveBeenCalled();
  });

  it('is a no-op returning false when lines is not an array', async () => {
    const ops = new EditorOperations(makeHost());

    const applied: boolean = await ops.applyContent(
      file,
      null as unknown as string[],
      { start: 0, removeCount: 0, newLines: [] },
    );

    expect(applied).toBe(false);
    expect(modify).not.toHaveBeenCalled();
  });
});
