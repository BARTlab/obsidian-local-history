/** @jest-environment jsdom */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { DiffOutputFormatType, DiffViewMode } from '@/consts';
import { GutterRevertHandler } from '@/modals/gutter-revert-handler';
import type { GutterRevertHost } from '@/modals/gutter-revert-handler';
import { HunkHelper } from '@/helpers/hunk.helper';
import { FileSnapshot } from '@/snapshots/file.snapshot';
import type { ModalsService } from '@/services/modals.service';
import type { SnapshotsService } from '@/services/snapshots.service';
import type LineChangeTrackerPlugin from '@/main';
import type { DiffRenderMode } from '@/types';
import type * as Diff from 'diff';
import type { TFile } from 'obsidian';

/**
 * Tests for {@link GutterRevertHandler} (T05), the per-hunk revert collaborator
 * the history modal owns. Extracted from the 2246-LOC modal, where the anchor
 * resolution and the revert flow were untestable; these run under jsdom and
 * cover the behaviour the gutter affordances rely on:
 *
 * - attachInlineReverts marks each hunk's anchor row (across line-by-line,
 *   side-by-side, and inline render modes) with the lct-hunk-anchor class and
 *   its hunk index, hangs a revert button on the gutter cell, and refreshes the
 *   nav-button state,
 * - clicking the affordance reverts only that hunk via SnapshotsService once the
 *   user confirms, then notifies the host, and
 * - a declined confirm leaves the content untouched.
 *
 * Real hunks (HunkHelper.diff) and a real FileSnapshot back the host so the
 * anchoring runs against genuine offsets rather than hand-built hunk objects.
 */
describe('GutterRevertHandler', () => {
  let container: HTMLElement;
  let displayMode: DiffRenderMode;
  let hunks: Diff.StructuredPatchHunk[];
  let snapshot: FileSnapshot;
  let confirmResult: boolean;
  let applyContent: jest.Mock;
  let onReverted: jest.Mock;
  let navRefreshed: number;

  const plugin = {
    t: (key: string): string => key,
  } as unknown as LineChangeTrackerPlugin;

  /**
   * Builds a diff2html line-number cell carrying the given numbers (line-by-line
   * packs old then new; a single number is one side-by-side column).
   *
   * @param {number[]} numbers - The line numbers the cell shows
   * @return {HTMLElement} The line-number cell
   */
  const lineNumberCell = (numbers: number[]): HTMLElement => {
    const cell = document.createElement('div');

    cell.className = 'd2h-code-linenumber';
    cell.textContent = numbers.join(' ');

    return cell;
  };

  /**
   * Builds a diff2html code row wrapper carrying a line-number cell.
   *
   * @param {number[]} numbers - The line numbers the row shows
   * @param {string} [extraClass] - An extra class (e.g. d2h-del) for the row
   * @return {HTMLElement} The row wrapper
   */
  const codeRow = (numbers: number[], extraClass?: string): HTMLElement => {
    const row = document.createElement('div');

    row.className = extraClass ? `d2h-code-row-wrapper ${extraClass}` : 'd2h-code-row-wrapper';
    row.appendChild(lineNumberCell(numbers));

    return row;
  };

  /**
   * Builds the host port over the mutable test state, mirroring the modal's
   * makeGutterRevertHost.
   *
   * @return {GutterRevertHost} The host port
   */
  const makeHost = (): GutterRevertHost => ({
    snapshot,
    plugin,
    modalsService: {
      confirm: (): Promise<boolean> => Promise.resolve(confirmResult),
    } as unknown as ModalsService,
    snapshotsService: {
      applyContent,
    } as unknown as SnapshotsService,
    diffContainer: (): HTMLElement | undefined => container,
    displayMode: (): DiffRenderMode => displayMode,
    getHunks: (): Diff.StructuredPatchHunk[] => hunks,
    updateNavButtonsState: (): void => {
      navRefreshed++;
    },
    onReverted: (): void => {
      onReverted();
    },
  });

  beforeEach((): void => {
    container = document.createElement('div');
    document.body.appendChild(container);
    displayMode = DiffOutputFormatType.line;
    confirmResult = true;
    applyContent = jest.fn(() => Promise.resolve());
    onReverted = jest.fn();
    navRefreshed = 0;
    // Base "a\nB\nc" vs current "a\nb\nc": a single modified middle line, so the
    // hunk's newStart is 2 (the current-side line of the change).
    snapshot = new FileSnapshot('a\nb\nc');
    const file = { path: 'note.md', name: 'note.md', extension: 'md' } as unknown as TFile;

    snapshot.file = file;
    hunks = HunkHelper.diff(['a', 'B', 'c'], ['a', 'b', 'c']);
  });

  describe('attachInlineReverts (anchoring)', () => {
    it('marks the line-by-line anchor row and hangs a revert button on its gutter', () => {
      // Rows for current lines 1..3; the modified line is line 2.
      container.appendChild(codeRow([1, 1]));
      const anchorRow = codeRow([2, 2]);

      container.appendChild(anchorRow);
      container.appendChild(codeRow([3, 3]));

      const handler = new GutterRevertHandler(makeHost());

      handler.attachInlineReverts();

      expect(anchorRow.classList.contains('lct-hunk-anchor')).toBe(true);
      expect(anchorRow.dataset.lctHunk).toBe('0');
      // The affordance lands on the line-number cell (the sticky gutter), not
      // the row body.
      expect(anchorRow.querySelector('.d2h-code-linenumber .lct-hunk-revert')).not.toBeNull();
      expect(navRefreshed).toBe(1);
    });

    it('anchors on the right column in side-by-side mode', () => {
      displayMode = DiffOutputFormatType.side;

      const leftColumn = document.createElement('div');
      const rightColumn = document.createElement('div');

      leftColumn.className = 'd2h-side-column';
      rightColumn.className = 'd2h-side-column';
      rightColumn.appendChild(codeRow([1]));
      const anchorRow = codeRow([2]);

      rightColumn.appendChild(anchorRow);
      container.appendChild(leftColumn);
      container.appendChild(rightColumn);

      const handler = new GutterRevertHandler(makeHost());

      handler.attachInlineReverts();

      expect(anchorRow.classList.contains('lct-hunk-anchor')).toBe(true);
      expect(anchorRow.dataset.lctHunk).toBe('0');
    });

    it('anchors positionally on the inline changed row', () => {
      displayMode = DiffViewMode.inline;

      const context = document.createElement('div');

      context.className = 'lct-inline-row lct-inline-context';
      const changed = document.createElement('div');

      changed.className = 'lct-inline-row';
      container.appendChild(context);
      container.appendChild(changed);

      const handler = new GutterRevertHandler(makeHost());

      handler.attachInlineReverts();

      // The modified line is the second current-side row, so the changed row is
      // the anchor; the inline mode has no gutter cell so the button is on the
      // row itself.
      expect(changed.classList.contains('lct-hunk-anchor')).toBe(true);
      expect(changed.querySelector('.lct-hunk-revert')).not.toBeNull();
    });

    it('does nothing when the diff container is absent', () => {
      container = undefined as unknown as HTMLElement;
      const handler = new GutterRevertHandler(makeHost());

      expect((): void => handler.attachInlineReverts()).not.toThrow();
      expect(navRefreshed).toBe(0);
    });
  });

  describe('hunk revert (affordance click)', () => {
    it('reverts only the clicked hunk via SnapshotsService after a confirm, then notifies the host', async () => {
      const anchorRow = codeRow([2, 2]);

      container.appendChild(codeRow([1, 1]));
      container.appendChild(anchorRow);
      container.appendChild(codeRow([3, 3]));

      const handler = new GutterRevertHandler(makeHost());

      handler.attachInlineReverts();
      const button = anchorRow.querySelector<HTMLButtonElement>('.lct-hunk-revert');

      button?.click();
      // The click handler runs revertHunk async; let its promise chain settle.
      await Promise.resolve();
      await Promise.resolve();

      expect(applyContent).toHaveBeenCalledTimes(1);
      const [file, revertedLines, opts] = applyContent.mock.calls[0] as [
        TFile,
        string[],
        { start: number; removeCount: number; newLines: string[] },
      ];

      expect(file).toBe(snapshot.file);
      // Reverting the single modified hunk restores the base middle line.
      expect(revertedLines).toEqual(['a', 'B', 'c']);
      expect(opts.start).toBe(1);
      expect(opts.newLines).toEqual(['B']);
      expect(onReverted).toHaveBeenCalledTimes(1);
    });

    it('does not write when the user declines the confirm', async () => {
      confirmResult = false;

      const anchorRow = codeRow([2, 2]);

      container.appendChild(codeRow([1, 1]));
      container.appendChild(anchorRow);

      const handler = new GutterRevertHandler(makeHost());

      handler.attachInlineReverts();
      anchorRow.querySelector<HTMLButtonElement>('.lct-hunk-revert')?.click();
      await Promise.resolve();
      await Promise.resolve();

      expect(applyContent).not.toHaveBeenCalled();
      expect(onReverted).not.toHaveBeenCalled();
    });
  });
});
