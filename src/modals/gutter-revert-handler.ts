import { DiffOutputFormatType, DiffViewMode } from '@/consts';
import { DomHelper } from '@/helpers/dom.helper';
import { HunkHelper } from '@/helpers/hunk.helper';
import type LineChangeTrackerPlugin from '@/main';
import type { ModalsService } from '@/services/modals.service';
import type { SnapshotsService } from '@/services/snapshots.service';
import type { FileSnapshot } from '@/snapshots/file.snapshot';
import type { DiffRenderMode } from '@/types';
import type * as Diff from 'diff';
import { setIcon, type TFile } from 'obsidian';

/**
 * Host port the {@link GutterRevertHandler} reads its shared modal state
 * through. The handler owns the revert affordances and the hunk anchoring but
 * stays stateless about the modal: it reads the live diff container, the active
 * display mode, and the current hunks back through this port, drives the revert
 * through the snapshot services, and reports a completed revert and the
 * post-decoration nav refresh back to the host.
 */
export interface GutterRevertHost {
  /**
   * The file snapshot whose live state the reverts write into.
   */
  readonly snapshot: FileSnapshot;

  /**
   * The plugin instance, used for translation lookups and the confirm copy.
   */
  readonly plugin: LineChangeTrackerPlugin;

  /**
   * Service that runs the confirm dialog before a destructive revert.
   */
  readonly modalsService: ModalsService;

  /**
   * Service that applies the reverted content and refreshes the highlights.
   */
  readonly snapshotsService: SnapshotsService;

  /**
   * The rendered diff container, or `undefined` before the first render. The
   * handler is a no-op when it is absent.
   *
   * @return {HTMLElement | undefined} The diff container, or undefined
   */
  diffContainer(): HTMLElement | undefined;

  /**
   * The active diff display mode, used to choose the anchor-resolution strategy
   * (inline rows vs diff2html rows, line-by-line vs side-by-side).
   *
   * @return {DiffRenderMode} The current display mode
   */
  displayMode(): DiffRenderMode;

  /**
   * The line-level hunks between the selected base and the live state, in
   * document order. Recomputed on demand so the offsets reflect live content.
   *
   * @return {Diff.StructuredPatchHunk[]} The hunks, top to bottom
   */
  getHunks(): Diff.StructuredPatchHunk[];

  /**
   * Refreshes the next/previous difference button state after the handler has
   * decorated the rows with their anchors (the hunk set is now known).
   */
  updateNavButtonsState(): void;

  /**
   * Reports a completed revert so the host can drop the stale hunk focus and
   * re-render the active diff against the new content.
   */
  onReverted(): void;
}

/**
 * Gutter-revert collaborator for the history modal (T05).
 *
 * Extracted from {@link HistoryModal} as a plain object the modal instantiates
 * and owns (per ADR-8 / Epic 14: deep collaborators, not DI services). It owns
 * the per-hunk revert affordance concern: decorating each rendered hunk with an
 * anchor marker and an inline revert button (JetBrains style), resolving the
 * anchor row across every diff render mode, and reverting a single hunk back to
 * the selected base on click. It is stateless about the modal and reads the
 * live diff container, display mode, and hunks back through
 * {@link GutterRevertHost}, reporting a completed revert and the post-decoration
 * nav refresh so the modal keeps coordinating the diff render and navigation.
 */
export class GutterRevertHandler {
  /**
   * @param {GutterRevertHost} host - The modal port the handler reads its shared
   *   state through and reports reverts to.
   */
  public constructor(protected readonly host: GutterRevertHost) {}

  /**
   * Post-processes the rendered diff to place one inline revert affordance at
   * the anchor row of each hunk, JetBrains style: a small revert arrow that
   * reverts only that block. It maps the rendered rows back to getHunks by their
   * current-side line number and marks each anchor with its hunk index, so the
   * next/previous navigation can scroll and highlight the same rows. Patch mode
   * renders a plain <pre> with no per-row structure, so it carries no affordance
   * and is skipped (handled by the caller). The nav button state is refreshed
   * here because the hunk set is now known.
   */
  public attachInlineReverts(): void {
    if (!this.host.diffContainer()) {
      return;
    }

    const hunks: Diff.StructuredPatchHunk[] = this.host.getHunks();

    hunks.forEach((hunk: Diff.StructuredPatchHunk, index: number): void => {
      const anchor: HTMLElement | null = this.resolveHunkAnchor(hunk);

      if (!anchor) {
        return;
      }

      anchor.classList.add('lct-hunk-anchor');
      anchor.dataset.lctHunk = String(index);

      /**
       * Host the revert affordance in the row's gutter (the sticky line-number
       * cell) so it stays pinned to the gutter while the diff scrolls
       * horizontally; the inline mode has no gutter and falls back to the row.
       */
      this.makeRevertAffordance(this.resolveHunkGutter(anchor), index);
    });

    this.host.updateNavButtonsState();
  }

  /**
   * Reverts a single hunk of the current diff back to the selected base and
   * leaves every other change intact. The hunk is resolved fresh from getHunks
   * (against the live content) by its index, the user confirms before the write,
   * and the revert reuses the same plumbing the editor gutter uses: HunkHelper to
   * scope the block, SnapshotsService.applyContent to write it and refresh the
   * highlights. The host is then notified so the active view is re-rendered and
   * the diff reflects the new content. A stale index (the diff changed under the
   * click) is a safe no-op.
   *
   * @param {number} index - The index of the hunk to revert in the current diff
   * @return {Promise<void>}
   */
  protected async revertHunk(index: number): Promise<void> {
    const snapshot: FileSnapshot = this.host.snapshot;
    const file: TFile | undefined = snapshot?.file;

    if (!file) {
      return;
    }

    const hunk: Diff.StructuredPatchHunk | undefined = this.host.getHunks()[index];

    if (!hunk) {
      return;
    }

    const confirmed: boolean = await this.host.modalsService.confirm({
      title: this.host.plugin.t('modal.confirm.revert.title'),
      message: this.host.plugin.t('modal.confirm.revert.message'),
      confirmText: this.host.plugin.t('modal.confirm.revert.button'),
      cancelText: this.host.plugin.t('modal.confirm.cancel'),
    });

    if (!confirmed) {
      return;
    }

    const currentLines: string[] = snapshot.getLastStateLines();
    const start: number = Math.max(0, Math.min(currentLines.length, hunk.newStart - 1));

    await this.host.snapshotsService.applyContent(
      file,
      HunkHelper.revertHunk(currentLines, hunk),
      {
        start,
        removeCount: hunk.newLines,
        newLines: HunkHelper.baseLinesForHunk(hunk),
      },
    );

    /**
     * The content changed, so the diff (and its hunk indices) is stale: the host
     * drops the navigation focus and redraws the active view, which re-attaches
     * the inline revert affordances against the new hunks.
     */
    this.host.onReverted();
  }

  /**
   * Resolves the element that hosts the inline revert affordance for an anchor
   * row. The diff2html modes (line-by-line, side-by-side) carry a sticky
   * line-number cell, which keeps the affordance pinned to the gutter while the
   * diff scrolls horizontally. The inline mode has no such cell, so the row
   * itself hosts the affordance.
   *
   * @param {HTMLElement} anchor - The hunk anchor row
   * @return {HTMLElement} The element the revert affordance is appended to
   */
  protected resolveHunkGutter(anchor: HTMLElement): HTMLElement {
    return anchor.querySelector<HTMLElement>('.d2h-code-linenumber') ?? anchor;
  }

  /**
   * Resolves the rendered diff row that anchors a hunk, across the three diff
   * modes that carry per-row structure. The anchor is the first current-side row
   * of the hunk (the hunk's newStart). A pure deletion (newLines === 0) has no
   * current-side row, so it anchors on the base-side row of its first removed
   * line instead, which is the row the user sees the deletion on.
   *
   * @param {Diff.StructuredPatchHunk} hunk - The hunk to anchor
   * @return {HTMLElement | null} The anchor row, or null when no row matches
   */
  protected resolveHunkAnchor(hunk: Diff.StructuredPatchHunk): HTMLElement | null {
    if (this.host.displayMode() === DiffViewMode.inline) {
      return this.resolveInlineAnchor(hunk);
    }

    return this.resolveDiff2HtmlAnchor(hunk);
  }

  /**
   * Resolves the anchor row inside the plugin-rendered inline diff. The inline
   * rows have no line numbers, so the anchor is found positionally: the inline
   * diff lists context and changed rows in document order, so the Nth changed
   * row group maps to the Nth hunk. The first row of the hunk's changed run is
   * the anchor.
   *
   * @param {Diff.StructuredPatchHunk} hunk - The hunk to anchor
   * @return {HTMLElement | null} The anchor row, or null when none matches
   */
  protected resolveInlineAnchor(hunk: Diff.StructuredPatchHunk): HTMLElement | null {
    const rows: HTMLElement[] = Array.from(
      this.diffContainer().querySelectorAll<HTMLElement>('.lct-inline-row'),
    );

    /**
     * Walk the rows tracking the current-side line number: every row that holds
     * a current-side line advances it (context, a whole addition, or a modified
     * line), while a pure removal does not. The anchor is the first changed row
     * whose current-side position reaches the hunk's newStart. A pure deletion
     * (newLines === 0) sits between current lines, so it anchors on the first
     * changed row at or after newStart.
     */
    let currentLine: number = 0;

    for (const row of rows) {
      const changed: boolean = !row.classList.contains('lct-inline-context');
      const hasNewLine: boolean = !row.classList.contains('lct-inline-removed');

      if (changed && currentLine + 1 >= hunk.newStart) {
        return row;
      }

      if (hasNewLine) {
        currentLine++;
      }
    }

    return null;
  }

  /**
   * Resolves the anchor row inside a diff2html render (line-by-line or
   * side-by-side). Both share the same .d2h-code-row-wrapper rows; for a hunk
   * that occupies current lines the anchor is the row whose current-side line
   * number equals the hunk's newStart (in side-by-side that number lives in the
   * right column, so only the right column's rows are searched). A pure deletion
   * has no current-side row: in line-by-line it shows as a d2h-del row in the
   * single stream; in side-by-side the deleted text sits in the left column,
   * keyed by the hunk's oldStart. Both are anchored accordingly.
   *
   * @param {Diff.StructuredPatchHunk} hunk - The hunk to anchor
   * @return {HTMLElement | null} The anchor row, or null when none matches
   */
  protected resolveDiff2HtmlAnchor(hunk: Diff.StructuredPatchHunk): HTMLElement | null {
    const container: HTMLElement = this.diffContainer();
    const sideBySide: boolean = this.host.displayMode() === DiffOutputFormatType.side;
    const columns: HTMLElement[] = sideBySide
      ? Array.from(container.querySelectorAll<HTMLElement>('.d2h-side-column'))
      : [];

    if (hunk.newLines > 0) {
      const newScope: ParentNode = sideBySide ? columns[1] ?? container : container;

      return this.rowAtLine(newScope, hunk.newStart);
    }

    /**
     * Pure deletion: in side-by-side the removed lines live in the left column,
     * keyed by the hunk's oldStart; in line-by-line they are d2h-del rows in the
     * single stream, anchored by the first one at or after the deletion point.
     */
    if (sideBySide) {
      return this.rowAtLine(columns[0] ?? container, hunk.oldStart);
    }

    const rows: HTMLElement[] = this.codeRows(container);

    return rows.find((row: HTMLElement): boolean => {
      const line: number | null = this.rowLine(row);

      return row.classList.contains('d2h-del') && (line === null || line >= hunk.newStart);
    }) ?? rows.find((row: HTMLElement): boolean => row.classList.contains('d2h-del')) ?? null;
  }

  /**
   * Finds the code row inside a scope whose line-number cell carries the given
   * line number. Used to anchor a hunk on the row at its current-side (or, for a
   * side-by-side deletion, base-side) start line.
   *
   * @param {ParentNode} scope - The container (or column) to search
   * @param {number} line - The 1-based line number to match
   * @return {HTMLElement | null} The matching row, or null when none matches
   */
  protected rowAtLine(scope: ParentNode, line: number): HTMLElement | null {
    return this.codeRows(scope).find((row: HTMLElement): boolean => this.rowLine(row) === line) ?? null;
  }

  /**
   * Collects the content code rows inside a scope, skipping the block headers.
   *
   * @param {ParentNode} scope - The container (or column) to search
   * @return {HTMLElement[]} The content rows, top to bottom
   */
  protected codeRows(scope: ParentNode): HTMLElement[] {
    return Array.from(
      scope.querySelectorAll<HTMLElement>('.d2h-code-row-wrapper:not(.d2h-code-header-wrapper)'),
    );
  }

  /**
   * Reads the line number a diff2html row carries, or null when the row has none
   * (an empty placeholder). The number is the last numeric token in the row's
   * line-number cell: line-by-line packs both the old and the new number there
   * (the new one last), and each side-by-side column carries a single number.
   *
   * @param {HTMLElement} row - The .d2h-code-row-wrapper to read
   * @return {number | null} The 1-based line number, or null
   */
  protected rowLine(row: HTMLElement): number | null {
    const cell: HTMLElement | null = row.querySelector<HTMLElement>('.d2h-code-linenumber');
    const numbers: RegExpMatchArray | null = cell?.textContent?.match(/\d+/g) ?? null;

    if (!numbers || numbers.length === 0) {
      return null;
    }

    return Number(numbers[numbers.length - 1]);
  }

  /**
   * Builds the inline revert affordance for a hunk inside the given gutter cell:
   * an accessible icon button that reverts only that hunk on click. It carries a
   * single tooltip via aria-label (Obsidian renders it), with no native title so
   * the hover hint is not shown twice, and a Lucide undo glyph set through
   * Obsidian so it matches the app's icon set instead of an emoji.
   *
   * @param {HTMLElement} gutter - The element to host the affordance
   * @param {number} index - The hunk index the affordance reverts
   * @return {void}
   */
  protected makeRevertAffordance(gutter: HTMLElement, index: number): void {
    const label: string = this.host.plugin.t('modal.revert-hunk');

    const button: HTMLButtonElement = DomHelper.create({
      tag: 'button',
      classes: ['lct-hunk-revert', 'clickable-icon'],
      attributes: { 'aria-label': label, 'type': 'button' },
      container: gutter,
      events: {
        click: (event: Event): void => {
          event.preventDefault();
          event.stopPropagation();
          void this.revertHunk(index);
        },
      },
    });

    setIcon(button, 'undo-2');
  }

  /**
   * The live diff container, narrowed to a non-null element. The public entry
   * point ({@link attachInlineReverts}) bails when the container is absent, and
   * a revert only fires from an affordance that was attached while it existed,
   * so the anchor-resolution helpers can read it without re-checking.
   *
   * @return {HTMLElement} The diff container
   */
  protected diffContainer(): HTMLElement {
    return this.host.diffContainer() as HTMLElement;
  }
}
