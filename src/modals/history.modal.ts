import { DiffOutputFormatType } from '@/consts';
import { Inject } from '@/decorators/inject.decorator';
import { DomHelper } from '@/helpers/dom.helper';
import { HunkHelper } from '@/helpers/hunk.helper';
import { type InlineDiffLine, WordDiffHelper } from '@/helpers/word-diff.helper';
import type LineChangeTrackerPlugin from '@/main';
import type { ModalsService } from '@/services/modals.service';
import type { SnapshotsService } from '@/services/snapshots.service';
import type { FileSnapshot } from '@/snapshots/file.snapshot';
import type { FileVersion } from '@/snapshots/file.version';
import type { DomElementConfig, FunctionVoid, HTMLElementWithScrollSync } from '@/types';
import * as Diff from 'diff';
import * as Diff2Html from 'diff2html';
import { type App, type ButtonComponent, Modal, Notice, Setting, type TFile } from 'obsidian';

/**
 * Sentinel id for the original baseline entry in the version list. Picking it
 * diffs the current state against the file's original captured content. Real
 * versions are keyed by their own id, which is never this value.
 */
const ORIGINAL_BASE_ID: string = 'original';

/**
 * Modal dialog that displays the history of changes for a file.
 * Shows a diff view comparing the original state with the current state.
 * Provides options to view the diff in different formats and to remove the file's history.
 *
 * @extends Modal
 */
export class HistoryModal extends Modal {
  /**
   * Service for managing file snapshots.
   * Injected using the @Inject decorator.
   */
  @Inject('SnapshotsService')
  protected snapshotsService: SnapshotsService;

  /**
   * Service for managing modal dialogs.
   * Injected using the @Inject decorator.
   */
  @Inject('ModalsService')
  protected modalsService: ModalsService;

  /**
   * Reference to the current diff container element.
   * Used for cleanup operations when switching between diff modes.
   */
  protected diffContainerEl?: HTMLElementWithScrollSync;

  /**
   * Container element holding the version timeline list, rebuilt to reflect the
   * selected base.
   */
  protected versionsEl?: HTMLElement;

  /**
   * Container element holding the per-hunk revert controls, rebuilt whenever the
   * diff between the selected base and the current state changes.
   */
  protected hunksEl?: HTMLElement;

  /**
   * Id of the currently selected diff base. Defaults to the original baseline;
   * may be set to an intermediate version's id to diff the current state against
   * that earlier point instead.
   */
  protected selectedBaseId: string = ORIGINAL_BASE_ID;

  /**
   * The current display mode for the diff view.
   * Can be 'patch', 'inline', 'line-by-line', or 'side-by-side'.
   * Defaults to 'side-by-side'.
   */
  protected currentDisplayMode: 'patch' | 'inline' | 'line-by-line' | 'side-by-side' = 'side-by-side';

  /**
   * References to the mode toggle buttons.
   * Used to update the active state when switching between diff modes.
   */
  protected modeButtons: {
    /** Button for patch mode */
    patch?: HTMLElement;
    /** Button for inline word-diff mode */
    inline?: HTMLElement;
    /** Button for line-by-line mode */
    lineByLine?: HTMLElement;
    /** Button for side-by-side mode */
    sideBySide?: HTMLElement;
  } = {};

  /**
   * Creates a new instance of HistoryModal.
   *
   * @param {App} app - The Obsidian app instance
   * @param {LineChangeTrackerPlugin} plugin - The plugin instance
   * @param {FileSnapshot} snapshot - The file snapshot to display history for
   */
  public constructor(
    public app: App,
    protected plugin: LineChangeTrackerPlugin,
    protected snapshot: FileSnapshot,
  ) {
    super(app);

    this.diffContainerEl = this.contentEl.createDiv('diff-container');
  }

  /**
   * Lifecycle method called when the modal is opened.
   * Sets up the UI, adds CSS classes, sets the title based on the snapshot state,
   * and renders the diff view.
   * Does nothing if no snapshot is provided.
   *
   * @override
   */
  public onOpen(): void {
    if (!this.snapshot) {
      return;
    }

    // Make modal UI
    this.makeUI();

    // Increasing the size of the modal window
    DomHelper.update(
      this.modalEl,
      { classes: { add: 'lct-diff-modal' } }
    );

    // Generate and display diff
    this.renderDiff();
  }

  /**
   * Lifecycle method called when the modal is closed.
   * Cleans up by emptying the content element and removing scroll sync listeners.
   *
   * @override
   */
  public onClose(): void {
    this.cleanupScrollSync();
    this.contentEl.empty();
  }

  /**
   * Gets the currently active button based on the current display mode.
   * Returns the button element that corresponds to the active diff view mode.
   *
   * @return {HTMLElement | null} The active button element, or null if no mode is active
   */
  protected getActiveButton(): HTMLElement | null {
    switch (this.currentDisplayMode) {
      case 'patch':
        return this.modeButtons.patch;
      case 'inline':
        return this.modeButtons.inline;
      case 'line-by-line':
        return this.modeButtons.lineByLine;
      case 'side-by-side':
        return this.modeButtons.sideBySide;
      default:
        return null;
    }
  }

  /**
   * Updates the active state of mode buttons based on the current display mode.
   */
  protected updateButtonActiveStates(): void {
    Object.values(this.modeButtons).forEach((button: HTMLElement): void => {
      DomHelper.update(
        button,
        { classes: { remove: 'mod-cta' } }
      );
    });

    const activeButton: HTMLElement = this.getActiveButton();

    if (!activeButton) {
      return;
    }

    DomHelper.update(
      activeButton,
      { classes: { add: 'mod-cta' } }
    );
  }

  /**
   * Restores the file to its original state and resets the history tracking.
   * Writes the original content back to the file and clears the snapshot.
   */
  protected async restoreOriginalFile(): Promise<void> {
    if (!this.snapshot) {
      return;
    }

    try {
      const originalContent: string = this.snapshot.getOriginalState();
      const file: TFile = this.snapshot.file;

      await this.app.vault.modify(file, originalContent);
      this.snapshotsService.wipeOne(file);

      new Notice('File restored to original state');

      this.close();
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (_error) {
      new Notice('Failed to restore file to original state');
    }
  }

  /**
   * Creates the UI elements for the diff view.
   */
  protected makeUI(): void {
    const isOrigin: boolean = this.snapshot?.isStateSameOriginal();
    const changeDateTime: string = this.snapshot?.getLastChangedDateTime();

    this.setTitle('History');

    // action buttons in a single row
    new Setting(this.contentEl)
      .setName('Last modified')
      .setDesc(isOrigin ? 'No changes' : changeDateTime)
      .addButton((btn: ButtonComponent): ButtonComponent =>
        btn
          .setButtonText('Remove file history')
          .setWarning()
          .onClick(async (): Promise<void> => {
            const confirmed: boolean = await this.modalsService.confirm({
              title: 'Remove file history',
              // eslint-disable-next-line @stylistic/max-len
              message: 'Are you sure you want to remove the change tracking history for this file? This action cannot be undone.',
              confirmText: 'Remove history'
            });

            if (confirmed) {
              this.snapshotsService?.wipeOne(this.snapshot.file);
              this.close();
            }
          }))
      .addButton((btn: ButtonComponent): ButtonComponent =>
        btn
          .setButtonText('Restore original')
          .setWarning()
          .onClick(async (): Promise<void> => {
            const confirmed: boolean = await this.modalsService.confirm({
              title: 'Restore original file',
              // eslint-disable-next-line @stylistic/max-len
              message: 'Are you sure you want to restore this file to its original state? All current changes will be lost and the change tracking history will be reset. This action cannot be undone.',
              confirmText: 'Restore file'
            });

            if (confirmed) {
              await this.restoreOriginalFile();
            }
          }))
      .addButton((btn: ButtonComponent): ButtonComponent => {
        this.modeButtons.patch = btn.buttonEl;

        return btn
          .setButtonText('Show patch')
          .onClick((): void => {
            this.showCleanPatch();
          });
      })
      .addButton((btn: ButtonComponent): ButtonComponent => {
        this.modeButtons.inline = btn.buttonEl;

        return btn
          .setButtonText('Inline')
          .onClick((): void => {
            this.renderInlineDiff();
          });
      })
      .addButton((btn: ButtonComponent): ButtonComponent => {
        this.modeButtons.lineByLine = btn.buttonEl;

        return btn
          .setButtonText('Line by line')
          .onClick((): void => {
            this.renderDiff(DiffOutputFormatType.line);
          });
      })
      .addButton((btn: ButtonComponent): ButtonComponent => {
        this.modeButtons.sideBySide = btn.buttonEl;

        return btn
          .setButtonText('Side by side')
          .onClick((): void => {
            this.renderDiff(DiffOutputFormatType.side);
          });
      });

    // Set the initial active state
    this.updateButtonActiveStates();

    // Version timeline, placed above the diff output.
    this.versionsEl = this.contentEl.createDiv('lct-versions');
    // Per-hunk revert controls, placed between the timeline and the diff output.
    this.hunksEl = this.contentEl.createDiv('lct-hunks');

    if (this.diffContainerEl && this.versionsEl.parentElement === this.contentEl) {
      this.contentEl.insertBefore(this.versionsEl, this.diffContainerEl);
    }

    if (this.diffContainerEl && this.hunksEl.parentElement === this.contentEl) {
      this.contentEl.insertBefore(this.hunksEl, this.diffContainerEl);
    }

    this.renderVersions();
    this.renderHunks();
  }

  /**
   * Renders the version timeline as a list of selectable bases. The list always
   * starts with the original baseline, followed by intermediate versions newest
   * first. The whole block is hidden when no intermediate versions exist, so a
   * file without a timeline keeps the simple original-vs-current view.
   * Selecting an entry sets it as the diff base and re-renders the active view.
   */
  protected renderVersions(): void {
    if (!this.versionsEl) {
      return;
    }

    const versions: FileVersion[] = this.snapshot.getVersions();

    if (versions.length === 0) {
      DomHelper.update(this.versionsEl, { text: null, classes: { add: 'lct-versions-empty' } });

      return;
    }

    DomHelper.update(this.versionsEl, { classes: { remove: 'lct-versions-empty' } });

    const items: DomElementConfig[] = [
      this.makeVersionItem(ORIGINAL_BASE_ID, 'Original', ''),
      ...versions.map((version: FileVersion, index: number): DomElementConfig =>
        this.makeVersionItem(version.id, `Version ${versions.length - index}`, version.getDateTime())
      ),
    ];

    DomHelper.update(this.versionsEl, {
      text: null,
      children: [
        {
          tag: 'div',
          classes: 'lct-versions-list',
          children: items,
        },
      ],
    });
  }

  /**
   * Builds a single selectable version list entry config.
   * The active entry carries a highlight class; clicking selects that base.
   *
   * @param {string} id - The base id (original sentinel or a version id)
   * @param {string} label - The primary label to show
   * @param {string} meta - Secondary text (capture time), empty for the original
   * @return {DomElementConfig} A DomHelper element config for the entry
   */
  protected makeVersionItem(id: string, label: string, meta: string): DomElementConfig {
    const active: boolean = this.selectedBaseId === id;
    const children: DomElementConfig[] = [{ tag: 'span', classes: 'lct-version-label', text: label }];

    if (meta) {
      children.push({ tag: 'span', classes: 'lct-version-meta', text: meta });
    }

    return {
      tag: 'div',
      classes: active ? ['lct-version-item', 'is-active'] : ['lct-version-item'],
      events: {
        click: (): void => {
          this.selectBase(id);
        },
      },
      children,
    };
  }

  /**
   * Selects a new diff base and refreshes the version list and active diff view.
   * No-op when the base is already selected.
   *
   * @param {string} id - The base id to select
   */
  protected selectBase(id: string): void {
    if (this.selectedBaseId === id) {
      return;
    }

    this.selectedBaseId = id;
    this.renderVersions();
    this.renderHunks();
    this.refreshActiveView();
  }

  /**
   * Re-renders whichever diff view is currently active. Used after the diff
   * base or the file content changes so the visible output stays in sync with
   * the selected mode without duplicating the mode dispatch at every call site.
   */
  protected refreshActiveView(): void {
    switch (this.currentDisplayMode) {
      case 'patch':
        this.showCleanPatch();

        return;
      case 'inline':
        this.renderInlineDiff();

        return;
      case 'line-by-line':
        this.renderDiff(DiffOutputFormatType.line);

        return;
      default:
        this.renderDiff(DiffOutputFormatType.side);
    }
  }

  /**
   * Resolves the content of the currently selected diff base.
   * Returns the original baseline when the original is selected (or the selected
   * version no longer exists), otherwise the picked version's captured content.
   *
   * @return {string} The base content to diff the current state against
   */
  protected getBaseContent(): string {
    if (this.selectedBaseId !== ORIGINAL_BASE_ID) {
      const version: FileVersion | null = this.snapshot.getVersion(this.selectedBaseId);

      if (version) {
        return version.getContent(this.snapshot.lineBreak);
      }
    }

    return this.snapshot.getOriginalState();
  }

  /**
   * Whether the current state is identical to the selected diff base.
   * Used to render the "no changes" placeholder when the picked base matches
   * the live content.
   *
   * @return {boolean} True when base and current content are equal
   */
  protected isBaseSameCurrent(): boolean {
    return this.getBaseContent() === this.snapshot.getLastState();
  }

  /**
   * Computes the line-level hunks between the selected base and the current
   * state. These back the per-hunk revert controls and are recomputed on demand
   * so the offsets always reflect the live content.
   *
   * @return {Diff.StructuredPatchHunk[]} The hunks, ordered top to bottom
   */
  protected getHunks(): Diff.StructuredPatchHunk[] {
    return HunkHelper.diff(
      this.getBaseContent().split(this.snapshot.lineBreak),
      this.snapshot.getLastStateLines(),
      this.snapshot.lineBreak,
    );
  }

  /**
   * Renders the per-hunk revert list for the current diff. Each entry describes
   * one changed block against the selected base and offers a control that writes
   * only that block back to the base, leaving every other change intact. The
   * block is hidden when the current state already equals the selected base.
   */
  protected renderHunks(): void {
    if (!this.hunksEl) {
      return;
    }

    const hunks: Diff.StructuredPatchHunk[] = this.getHunks();

    if (hunks.length === 0) {
      DomHelper.update(this.hunksEl, { text: null, classes: { add: 'lct-hunks-empty' } });

      return;
    }

    DomHelper.update(this.hunksEl, { classes: { remove: 'lct-hunks-empty' } });

    const items: DomElementConfig[] = hunks.map((hunk: Diff.StructuredPatchHunk, index: number): DomElementConfig => ({
      tag: 'div',
      classes: 'lct-hunk-item',
      children: [
        { tag: 'span', classes: 'lct-hunk-label', text: this.getHunkLabel(hunk) },
        {
          tag: 'button',
          classes: ['lct-hunk-revert-button', 'mod-outline'],
          text: 'Revert hunk',
          events: {
            click: (): void => {
              void this.revertHunk(index);
            },
          },
        },
      ],
    }));

    DomHelper.update(this.hunksEl, {
      text: null,
      children: [
        { tag: 'div', classes: 'lct-hunks-title', text: 'Revert individual changes' },
        { tag: 'div', classes: 'lct-hunks-list', children: items },
      ],
    });
  }

  /**
   * Builds a short, human-readable label for a hunk describing where it sits in
   * the current document and what kind of change it is.
   *
   * @param {Diff.StructuredPatchHunk} hunk - The hunk to describe
   * @return {string} A sentence-case label for the hunk
   */
  protected getHunkLabel(hunk: Diff.StructuredPatchHunk): string {
    // Pure deletion: nothing occupies the region in the current document.
    if (hunk.newLines === 0) {
      return `Removed before line ${hunk.newStart + 1}`;
    }

    const start: number = hunk.newStart;
    const end: number = hunk.newStart + hunk.newLines - 1;
    const where: string = start === end ? `line ${start}` : `lines ${start}-${end}`;

    if (hunk.oldLines === 0) {
      return `Added ${where}`;
    }

    return `Changed ${where}`;
  }

  /**
   * Reverts a single hunk back to the selected base, leaving all other changes
   * intact, then refreshes the timeline, the revert list, and the active diff.
   *
   * The hunks are recomputed against the live content before resolving the
   * target, so a stale index from a previous render cannot apply the wrong
   * block. The revert targets whichever base is currently selected in the
   * timeline (the original baseline by default, or a picked version), matching
   * exactly what the diff above shows.
   *
   * @param {number} index - The index of the hunk in the current diff
   * @return {Promise<void>}
   */
  protected async revertHunk(index: number): Promise<void> {
    if (!this.snapshot?.file) {
      return;
    }

    const hunks: Diff.StructuredPatchHunk[] = this.getHunks();
    const hunk: Diff.StructuredPatchHunk | undefined = hunks[index];

    if (!hunk) {
      return;
    }

    const confirmed: boolean = await this.modalsService.confirm({
      title: 'Revert change',
      message: 'Revert this change back to the selected version? Other changes are kept.',
      confirmText: 'Revert',
    });

    if (!confirmed) {
      return;
    }

    const currentLines: string[] = this.snapshot.getLastStateLines();
    const revertedLines: string[] = HunkHelper.revertHunk(currentLines, hunk);
    const start: number = Math.max(0, Math.min(currentLines.length, hunk.newStart - 1));

    const applied: boolean = await this.snapshotsService.applyContent(
      this.snapshot.file,
      revertedLines,
      {
        start,
        removeCount: hunk.newLines,
        newLines: HunkHelper.baseLinesForHunk(hunk),
      },
    );

    if (!applied) {
      new Notice('Failed to revert change');

      return;
    }

    new Notice('Change reverted');

    // Refresh every view that depends on the current state.
    this.renderVersions();
    this.renderHunks();
    this.refreshActiveView();
  }

  /**
   * Generates a unified diff between the selected base and the current state.
   * If they differ, use the diff library to create a patch.
   * If they are identical, create a simple diff header with the file content.
   *
   * @return {string} A string containing the unified diff
   */
  protected getDiffLines(): string {
    if (!this.snapshot?.file?.path) {
      return '';
    }

    const filePath: string = this.snapshot.file.path;
    const base: string = this.getBaseContent();
    const current: string = this.snapshot.getLastState();

    if (!this.isBaseSameCurrent()) {
      return Diff.createTwoFilesPatch(
        filePath,
        filePath,
        base ?? '',
        current ?? '',
        '',
        '',
        {
          context: Number.MAX_SAFE_INTEGER,
        }
      );
    }

    return [
      '===================================================================',
      `--- ${filePath}\t`,
      `+++ ${filePath}\t`,
      `@@ -1,${base.length} +1,${current.length} @@`,
      this.snapshot
        .getLastStateLines()
        .map((content) => ` ${content}`)
        .join('\n'),
      '\\ No newline at end of file'
    ].join('\n');
  }

  /**
   * Generates a clean patch with context size 0 between the original and current state of the file.
   * Shows only the changed lines without surrounding context.
   *
   * @return {string} A string containing the clean patch
   */
  protected getCleanPatch(): string {
    if (!this.snapshot?.file?.path) {
      return '';
    }

    const filePath: string = this.snapshot.file.path;
    const base: string = this.getBaseContent();
    const current: string = this.snapshot.getLastState();

    if (!this.isBaseSameCurrent()) {
      return Diff.createTwoFilesPatch(
        filePath,
        filePath,
        base ?? '',
        current ?? '',
        '',
        '',
        {
          context: 0,
        }
      );
    }

    // If no changes, return an empty patch
    return `--- ${filePath}\t\n+++ ${filePath}\t\n`;
  }

  /**
   * Shows the clean patch in a readable format.
   * Displays the patch with context size 0 in a pre-formatted text element.
   */
  protected showCleanPatch(): void {
    // Update current mode and button states,
    // clean up previous scroll synchronization
    this.currentDisplayMode = 'patch';
    this.updateButtonActiveStates();
    this.cleanupScrollSync();

    const patch: string = this.getCleanPatch();

    const handlerClick: FunctionVoid = (): void => {
      navigator.clipboard.writeText(patch).then(() => {
        new Notice('Copied!');
      });
    }

    // Create a patch display container
    DomHelper.update(
      this.diffContainerEl,
      {
        text: null,
        children: [
          {
            tag: 'div',
            classes: 'lct-patch-container',
            children: [
              {
                tag: 'pre',
                classes: 'lct-patch-text',
                text: patch
              },
              {
                tag: 'button',
                text: 'Copy',
                classes: ['lct-patch-copy-button', 'mod-outline'],
                events: {
                  click: handlerClick
                }
              }
            ]
          }
        ]
      }
    );
  }

  /**
   * Renders an inline diff between the selected base and the current state,
   * highlighting changed words inside modified lines instead of marking the
   * whole line. Context lines are shown plain, pure additions and removals are
   * shown whole in their colour, and a modified line is shown as its old text
   * (with removed words highlighted) above its new text (with added words
   * highlighted). The whole view is built with safe DOM nodes (no raw HTML);
   * each word span carries a class the stylesheet colours.
   */
  protected renderInlineDiff(): void {
    // Update current mode and button states,
    // clean up previous scroll synchronization.
    this.currentDisplayMode = 'inline';
    this.updateButtonActiveStates();
    this.cleanupScrollSync();

    if (this.isBaseSameCurrent()) {
      DomHelper.update(this.diffContainerEl, {
        text: null,
        children: [{ tag: 'div', classes: 'lct-inline-empty', text: 'No changes' }],
      });

      return;
    }

    const diffLines: InlineDiffLine[] = WordDiffHelper.lines(this.getBaseContent(), this.snapshot.getLastState());
    const rows: DomElementConfig[] = [];

    diffLines.forEach((line: InlineDiffLine): void => {
      if (line.type === 'context') {
        rows.push(this.makeInlineRow('context', ' ', [{ tag: 'span', text: line.oldText ?? '' }]));

        return;
      }

      if (line.type === 'added') {
        rows.push(this.makeInlineRow('added', '+', [
          { tag: 'span', classes: 'lct-word-added', text: line.newText ?? '' },
        ]));

        return;
      }

      if (line.type === 'removed') {
        rows.push(this.makeInlineRow('removed', '-', [
          { tag: 'span', classes: 'lct-word-removed', text: line.oldText ?? '' },
        ]));

        return;
      }

      // Modified: old text with removed words, then new text with added words.
      rows.push(this.makeInlineRow('removed', '-', this.makeWordSpans(line.oldText ?? '', line.newText ?? '', 'old')));
      rows.push(this.makeInlineRow('added', '+', this.makeWordSpans(line.oldText ?? '', line.newText ?? '', 'new')));
    });

    DomHelper.update(this.diffContainerEl, {
      text: null,
      children: [{ tag: 'div', classes: 'lct-inline-container', children: rows }],
    });
  }

  /**
   * Builds one inline diff row: a sign gutter (a space, plus, or minus) and the
   * line content made of the provided spans.
   *
   * @param {string} kind - The row kind, used as a modifier class
   * @param {string} sign - The leading sign character for the row
   * @param {DomElementConfig[]} content - The content spans for the line
   * @return {DomElementConfig} The row element config
   */
  protected makeInlineRow(kind: string, sign: string, content: DomElementConfig[]): DomElementConfig {
    return {
      tag: 'div',
      classes: ['lct-inline-row', `lct-inline-${kind}`],
      children: [
        { tag: 'span', classes: 'lct-inline-sign', text: sign },
        { tag: 'span', classes: 'lct-inline-content', children: content },
      ],
    };
  }

  /**
   * Computes the word-level spans for one side of a modified line. The old side
   * keeps unchanged and removed words (removed words highlighted); the new side
   * keeps unchanged and added words (added words highlighted). An empty side
   * yields no spans.
   *
   * @param {string} oldText - The old (base) line text
   * @param {string} newText - The new (current) line text
   * @param {'old' | 'new'} side - Which side of the modification to render
   * @return {DomElementConfig[]} The span configs for that side
   */
  protected makeWordSpans(oldText: string, newText: string, side: 'old' | 'new'): DomElementConfig[] {
    const spans: DomElementConfig[] = [];

    WordDiffHelper.segments(oldText, newText).forEach((segment: Diff.Change): void => {
      // Skip the segments that do not belong on this side.
      if (side === 'old' && segment.added) {
        return;
      }

      if (side === 'new' && segment.removed) {
        return;
      }

      const classes: string | undefined = segment.added
        ? 'lct-word-added'
        : segment.removed
          ? 'lct-word-removed'
          : undefined;

      spans.push(classes ? { tag: 'span', classes, text: segment.value } : { tag: 'span', text: segment.value });
    });

    return spans;
  }

  /**
   * Renders the diff view in the specified container.
   * Converts the unified diff to HTML using the diff2html library.
   * Supports two formats: 'line-by-line' and 'side-by-side'.
   * Use custom templates to control the HTML structure and styling.
   *
   * @param {DiffOutputFormatType} format - The format of the diff view (defaults to 'side-by-side')
   */
  protected renderDiff(format: DiffOutputFormatType = DiffOutputFormatType.side): void {
    // Update current mode and button states,
    // clean up previous scroll synchronization
    this.currentDisplayMode = format;
    this.updateButtonActiveStates();
    this.cleanupScrollSync();

    const diffHtml: string = Diff2Html.html(this.getDiffLines(), {
      drawFileList: false,
      matching: 'lines',
      outputFormat: format,
      renderNothingWhenEmpty: true,
      rawTemplates: {
        'line-by-line-file-diff': `
           {{{diffs}}}
        `,
        'side-by-side-file-diff': `
          <div class="d2h-side-column">
            <div class="d2h-side-column-wrapper">
                <div class="d2h-side-column-container">
                  {{{diffs.left}}}
              </div>
            </div>
          </div>
          <div class="d2h-side-column">
            <div class="d2h-side-column-wrapper">
                <div class="d2h-side-column-container">
                  {{{diffs.right}}}
              </div>
            </div>
          </div>
        `,
        'generic-wrapper': `
          <div class="d2h-wrapper d2h-${format === DiffOutputFormatType.line ? 'line' : 'side'}">
            <div class="d2h-container">
                {{{content}}}
            </div>
          </div>
        `,
        'generic-block-header': `
          <div class="d2h-code-row-wrapper d2h-code-header-wrapper {{CSSLineClass.INFO}}">
              <div class="d2h-code-linenumber {{CSSLineClass.INFO}}"></div>
              <div class="d2h-code-linecontent {{CSSLineClass.INFO}}">
                  <div class="d2h-code-line d2h-code-row">
                    <span class="d2h-code-line-prefix">&nbsp;</span>
                    <span class="d2h-code-line-ctn">
                      {{#blockHeader}}{{{blockHeader}}}{{/blockHeader}}{{^blockHeader}}&nbsp;{{/blockHeader}}
                    </span>
                  </div>
              </div>
          </div>
        `,
        'generic-line': `
          <div class="d2h-code-row-wrapper {{type}}">
            <div class="d2h-code-linenumber {{type}}">
              {{{lineNumber}}}
            </div>
            <div class="d2h-code-linecontent {{type}}">
                <div class="d2h-code-line d2h-code-row">
                  {{#prefix}}
                      <span class="d2h-code-line-prefix">{{{prefix}}}</span>
                  {{/prefix}}
                  {{^prefix}}
                      <span class="d2h-code-line-prefix">&nbsp;</span>
                  {{/prefix}}
                  {{#content}}
                      <span class="d2h-code-line-ctn">{{{content}}}</span>
                  {{/content}}
                  {{^content}}
                      <span class="d2h-code-line-ctn"><br></span>
                  {{/content}}
                </div>
            </div>
        </div>
        `,
      },
    });

    DomHelper.update(
      this.diffContainerEl,
      { html: diffHtml }
    );

    // Scroll synchronization for a side-by-side diff view,
    // uses setTimeout to ensure DOM elements are rendered
    if (format === 'side-by-side') {
      setTimeout(() => this.setupScrollSynchronization(), 0);
    }
  }

  /**
   * Sets up scroll synchronization for a side-by-side diff view.
   * Finds the scrollable wrapper elements for both columns and adds event listeners
   * to synchronize both vertical and horizontal scroll positions.
   */
  protected setupScrollSynchronization(): void {
    const wrappers = this.diffContainerEl.querySelectorAll('.d2h-side-column-wrapper') as NodeListOf<HTMLElement>;

    if (wrappers?.length !== 2) {
      return;
    }

    const [leftWrapper, rightWrapper] = wrappers;
    let isScrolling: boolean = false;

    // Synchronize scroll from left to right
    const syncLeftToRight: FunctionVoid = (): void => {
      if (isScrolling) {
        return;
      }

      isScrolling = true;
      rightWrapper.scrollTop = leftWrapper.scrollTop;
      rightWrapper.scrollLeft = leftWrapper.scrollLeft;

      requestAnimationFrame((): void => {
        isScrolling = false;
      });
    };

    // Synchronize scroll from right to left
    const syncRightToLeft: FunctionVoid = (): void => {
      if (isScrolling) {
        return;
      }

      isScrolling = true;
      leftWrapper.scrollTop = rightWrapper.scrollTop;
      leftWrapper.scrollLeft = rightWrapper.scrollLeft;

      requestAnimationFrame((): void => {
        isScrolling = false;
      });
    };

    // Add scroll event listeners
    leftWrapper.addEventListener('scroll', syncLeftToRight);
    rightWrapper.addEventListener('scroll', syncRightToLeft);

    // Store references for cleanup (if needed later)
    this.diffContainerEl._scrollSyncCleanup = (): void => {
      leftWrapper.removeEventListener('scroll', syncLeftToRight);
      rightWrapper.removeEventListener('scroll', syncRightToLeft);
    };
  }

  /**
   * Cleans up scroll synchronization event listeners.
   * Called when switching between diff modes or closing the modal.
   */
  protected cleanupScrollSync(): void {
    const container: HTMLElementWithScrollSync = this.diffContainerEl;

    if (container?._scrollSyncCleanup) {
      container._scrollSyncCleanup();

      delete container._scrollSyncCleanup;
    }
  }
}
