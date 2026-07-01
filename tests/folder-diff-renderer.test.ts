/** @jest-environment jsdom */

import { beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { DiffOutputFormatType, DiffViewMode } from '@/consts';
import { FolderDiffRenderer } from '@/modals/folder-diff-renderer';
import type { FolderDiffHost } from '@/modals/folder-diff-renderer.types';
import { FileSnapshot } from '@/snapshots/file.snapshot';
import { FileVersion } from '@/snapshots/file.version';
import type LineChangeTrackerPlugin from '@/main';
import type { DiffRenderMode } from '@/types';
import { installJsdomDomPolyfill } from './helpers/jsdom-dom';

/**
 * Tests for {@link FolderDiffRenderer}, the diff-pane collaborator the
 * folder-history modal owns. Extracted from the 1416-LOC modal, where the diff
 * body, the above-diff notice, and the side-by-side column header were tangled
 * with the toolbar; these run under jsdom and cover the behaviour the diff pane
 * relies on:
 *
 * - refresh renders the diff into the body for a modified file and signals the
 *   host's `onDiffRendered` so the toolbar buttons re-sync,
 * - the notice reflects the file's status at T (added / deleted / unchanged /
 *   no-file) and hides on a plain modification,
 * - the side-by-side column header shows only in side-by-side mode and clears in
 *   the single-column modes, and
 * - a no-file / empty selection clears the diff body instead of leaving stale
 *   content, still firing `onDiffRendered`.
 *
 * A real {@link FileSnapshot} backs the host so the per-file delta runs against
 * the genuine `FolderDeltaHelper.compareAt`, not a hand-built result.
 */
describe('FolderDiffRenderer', () => {
  /**
   * Obsidian augments HTMLElement.prototype with `empty()` at runtime; jsdom
   * does not, and DomHelper.update calls it before pasting parsed HTML in the
   * diff2html (side-by-side) branch. Install the shared polyfill the renderer
   * touches.
   */
  beforeAll((): void => {
    installJsdomDomPolyfill();
  });

  let diffEl: HTMLElement | undefined;
  let noticeEl: HTMLElement | undefined;
  let columnsHeaderEl: HTMLElement | undefined;
  let displayMode: DiffRenderMode;
  let selectedTimestamp: number;
  let selectedPath: string | null;
  let snapshotsByPath: Map<string, FileSnapshot>;
  let rendered: number;

  const plugin = {
    t: (key: string): string => key,
  } as unknown as LineChangeTrackerPlugin;

  const makeHost = (): FolderDiffHost => ({
    plugin,
    diffContainerEl: (): HTMLElement | undefined => diffEl,
    noticeEl: (): HTMLElement | undefined => noticeEl,
    columnsHeaderEl: (): HTMLElement | undefined => columnsHeaderEl,
    displayMode: (): DiffRenderMode => displayMode,
    selectedTimestamp: (): number => selectedTimestamp,
    selectedPath: (): string | null => selectedPath,
    snapshotsByPath: (): Map<string, FileSnapshot> => snapshotsByPath,
    onDiffRendered: (): void => {
      rendered++;
    },
  });

  /**
   * Builds a live snapshot carrying a single captured version (the base content
   * at t=100) and a current state, so `compareAt` at the test's T=1000 resolves
   * its base to that version and reports `modified` (or `none` when base equals
   * current). Seeding a version pins the base deterministically rather than
   * relying on the no-version last-changed fallback.
   *
   * @param {string} base - The captured base content at t=100
   * @param {string} current - The live content
   * @return {FileSnapshot} The seeded snapshot
   */
  const makeSnapshot = (base: string, current: string): FileSnapshot => {
    const snapshot = new FileSnapshot(base);

    snapshot.timeline.adopt([new FileVersion(base.split('\n'), 100)]);
    snapshot.content.updateState(current.split('\n'));

    return snapshot;
  };

  beforeEach((): void => {
    diffEl = document.createElement('div');
    noticeEl = document.createElement('div');
    columnsHeaderEl = document.createElement('div');
    document.body.append(diffEl, noticeEl, columnsHeaderEl);
    displayMode = DiffViewMode.inline;
    // T after the seeded version (t=100) so a live snapshot existed at T and its
    // base resolves to that version.
    selectedTimestamp = 1000;
    selectedPath = null;
    snapshotsByPath = new Map();
    rendered = 0;
  });

  it('renders a diff for a modified file and signals onDiffRendered', () => {
    const snapshot = makeSnapshot('one\ntwo', 'one\ntwo-changed');

    snapshotsByPath.set('a.md', snapshot);
    selectedPath = 'a.md';

    new FolderDiffRenderer(makeHost()).refresh();

    expect((diffEl as HTMLElement).childElementCount).toBeGreaterThan(0);
    expect(rendered).toBe(1);
    // A plain modification shows no banner.
    expect((noticeEl as HTMLElement).classList.contains('lct-diff-notice-hidden')).toBe(true);
  });

  it('clears the diff body and still signals onDiffRendered when nothing is selected', () => {
    diffEl?.appendChild(document.createElement('span'));
    selectedPath = null;

    new FolderDiffRenderer(makeHost()).refresh();

    expect((diffEl as HTMLElement).childElementCount).toBe(0);
    expect(rendered).toBe(1);
    // The no-file notice is shown.
    expect((noticeEl as HTMLElement).classList.contains('lct-diff-notice-hidden')).toBe(false);
    expect((noticeEl as HTMLElement).textContent).toBe('modal.folder.notice.no-file');
  });

  it('shows the unchanged notice for a file equal to its base at T', () => {
    const snapshot = makeSnapshot('same', 'same');

    snapshotsByPath.set('a.md', snapshot);
    selectedPath = 'a.md';

    new FolderDiffRenderer(makeHost()).refresh();

    expect((noticeEl as HTMLElement).textContent).toBe('modal.folder.notice.unchanged');
  });

  describe('side-by-side column header', () => {
    it('is shown only in side-by-side mode', () => {
      displayMode = DiffOutputFormatType.side;
      const snapshot = makeSnapshot('one', 'one-changed');

      snapshotsByPath.set('a.md', snapshot);
      selectedPath = 'a.md';

      new FolderDiffRenderer(makeHost()).refresh();

      expect((columnsHeaderEl as HTMLElement).classList.contains('lct-diff-columns-hidden')).toBe(false);
      expect((columnsHeaderEl as HTMLElement).querySelectorAll('.lct-diff-column-title').length).toBe(2);
    });

    it('is hidden in a single-column mode', () => {
      displayMode = DiffViewMode.inline;
      const snapshot = makeSnapshot('one', 'one-changed');

      snapshotsByPath.set('a.md', snapshot);
      selectedPath = 'a.md';

      new FolderDiffRenderer(makeHost()).refresh();

      expect((columnsHeaderEl as HTMLElement).classList.contains('lct-diff-columns-hidden')).toBe(true);
    });
  });

  it('is a no-op when the diff container is absent', () => {
    diffEl = undefined;

    expect((): void => new FolderDiffRenderer(makeHost()).refresh()).not.toThrow();
    expect(rendered).toBe(0);
  });
});
