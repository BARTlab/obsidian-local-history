import { Inject } from '@/decorators/inject.decorator';
import { DomHelper } from '@/helpers/dom.helper';
import type LineChangeTrackerPlugin from '@/main';
import type { ModalsService } from '@/services/modals.service';
import type { SnapshotsService } from '@/services/snapshots.service';
import type { FileSnapshot } from '@/snapshots/file.snapshot';
import type { FunctionVoid, HTMLElementWithScrollSync } from '@/types';
import * as Diff from 'diff';
import * as Diff2Html from 'diff2html';
import type { OutputFormatType } from 'diff2html/lib/types';
import { type App, type ButtonComponent, Modal, Notice, Setting, type TFile } from 'obsidian';

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
  private currentDiffContainer?: HTMLElement;

  /**
   * The current display mode for the diff view.
   * Can be 'patch', 'line-by-line', or 'side-by-side'.
   * Defaults to 'side-by-side'.
   */
  private currentDisplayMode: 'patch' | 'line-by-line' | 'side-by-side' = 'side-by-side';

  /**
   * References to the mode toggle buttons.
   * Used to update the active state when switching between diff modes.
   */
  private modeButtons: {
    /** Button for patch mode */
    patch?: HTMLElement;
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

    const subTitle: string = this.snapshot.isStateSameOriginal()
      ? 'no changes'
      : `last change at ${new Date(this.snapshot.timestamp).toLocaleString()}`;

    // Increasing the size of the modal window
    this.modalEl.addClass('lct-diff-modal');
    this.setTitle(`History (${subTitle})`);

    // Generate and display diff
    this.renderDiff(this.makeUI());
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
  private getActiveButton(): HTMLElement | null {
    switch (this.currentDisplayMode) {
      case 'patch':
        return this.modeButtons.patch;
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
  private updateButtonActiveStates(): void {
    Object.values(this.modeButtons).forEach((button: HTMLElement): void => {
      button?.removeClass('mod-cta');
    });

    const activeButton: HTMLElement = this.getActiveButton();

    activeButton?.addClass('mod-cta');
  }

  /**
   * Restores the file to its original state and resets the history tracking.
   * Writes the original content back to the file and clears the snapshot.
   */
  private async restoreOriginalFile(): Promise<void> {
    try {
      const originalContent: string = this.snapshot.getOriginalState();
      const file: TFile = (this.snapshot as FileSnapshot).file;

      // Write original content back to the file
      await this.app.vault.modify(file, originalContent);

      // Reset the snapshot history
      this.snapshotsService.wipeOne(file);

      // Show success notification
      new Notice('File restored to original state');

      // Close the modal
      this.close();
    } catch (error) {
      console.error('Failed to restore original file:', error);
      new Notice('Failed to restore file to original state');
    }
  }

  /**
   * Creates the UI elements for the diff view.
   * Creates a container for the diff and adds buttons for different actions:
   * - Remove file history: Deletes the snapshot and closes the modal
   * - Line by line: Switches to line-by-line diff view
   * - Side by side: Switches to side-by-side diff view
   *
   * @return {HTMLElement} The container element for the diff view
   */
  protected makeUI(): HTMLElement {
    const diffContainer: HTMLElement = this.contentEl.createDiv('diff-container');

    // All buttons in a single row
    new Setting(this.contentEl)
      .addButton((btn: ButtonComponent): ButtonComponent =>
        btn
          .setButtonText('Remove file history')
          .setWarning()
          .onClick(async (): Promise<void> => {
            const confirmed: boolean = await this.modalsService.confirm({
              title: 'Remove File History',
              // eslint-disable-next-line max-len
              message: 'Are you sure you want to remove the change tracking history for this file? This action cannot be undone.',
              confirmText: 'Remove History'
            });

            if (confirmed) {
              this.snapshotsService.wipeOne((this.snapshot as FileSnapshot).file);
              this.close();
            }
          }))
      .addButton((btn: ButtonComponent): ButtonComponent =>
        btn
          .setButtonText('Restore original')
          .setWarning()
          .onClick(async (): Promise<void> => {
            const confirmed: boolean = await this.modalsService.confirm({
              title: 'Restore Original File',
              // eslint-disable-next-line max-len
              message: 'Are you sure you want to restore this file to its original state? All current changes will be lost and the change tracking history will be reset. This action cannot be undone.',
              confirmText: 'Restore File'
            });

            if (confirmed) {
              await this.restoreOriginalFile();
            }
          }))
      .addButton((btn: ButtonComponent): ButtonComponent => {
        this.modeButtons.patch = btn.buttonEl;

        return btn
          .setButtonText('Show patch')
          .onClick(() => {
            this.showCleanPatch();
          });
      })
      .addButton((btn: ButtonComponent): ButtonComponent => {
        this.modeButtons.lineByLine = btn.buttonEl;

        return btn
          .setButtonText('Line by line')
          .onClick(() => {
            this.renderDiff(diffContainer, 'line-by-line');
          });
      })
      .addButton((btn: ButtonComponent): ButtonComponent => {
        this.modeButtons.sideBySide = btn.buttonEl;

        return btn
          .setButtonText('side-by-side')
          .onClick((): void => {
            this.renderDiff(diffContainer, 'side-by-side');
          });
      });

    // Set the initial active state
    this.updateButtonActiveStates();

    return diffContainer;
  }

  /**
   * Generates a unified diff between the original and current state of the file.
   * If the file has changes, use the diff library to create a patch.
   * If the file has no changes, create a simple diff header with the file content.
   *
   * @return {string} A string containing the unified diff
   */
  protected getDiffLines(): string {
    const filePath: string = (this.snapshot as FileSnapshot).file.path;
    const original: string = this.snapshot.getOriginalState();
    const current: string = this.snapshot.getLastState();

    if (!this.snapshot.isStateSameOriginal()) {
      return Diff.createTwoFilesPatch(
        filePath,
        filePath,
        original ?? '',
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
      `@@ -1,${original.length} +1,${current.length} @@`,
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
    const filePath: string = (this.snapshot as FileSnapshot).file.path;
    const original: string = this.snapshot.getOriginalState();
    const current: string = this.snapshot.getLastState();

    if (!this.snapshot.isStateSameOriginal()) {
      return Diff.createTwoFilesPatch(
        filePath,
        filePath,
        original ?? '',
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
    const diffContainer = this.contentEl.querySelector('.diff-container') as HTMLElement;

    if (!diffContainer) {
      return;
    }

    // Update current mode and button states
    this.currentDisplayMode = 'patch';
    this.updateButtonActiveStates();

    // Clean up previous scroll synchronization
    this.cleanupScrollSync();

    const patch = this.getCleanPatch();

    // Create a patch display container
    diffContainer.innerHTML = '';

    // Create a patch display using DomHelper with a container parameter
    DomHelper.create({
      tag: 'div',
      classes: 'lct-patch-container',
      container: diffContainer,
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
            click: () => {
              navigator.clipboard.writeText(patch).then(() => {
                new Notice('Copied!');
              });
            }
          }
        }
      ]
    });
  }

  /**
   * Renders the diff view in the specified container.
   * Converts the unified diff to HTML using the diff2html library.
   * Supports two formats: 'line-by-line' and 'side-by-side'.
   * Use custom templates to control the HTML structure and styling.
   *
   * @param {HTMLElement} container - The HTML element to render the diff into
   * @param {OutputFormatType} format - The format of the diff view (defaults to 'side-by-side')
   */
  protected renderDiff(container: HTMLElement, format: OutputFormatType = 'side-by-side'): void {
    const suffix = format === 'line-by-line' ? 'line' : 'side';

    // Update current mode and button states
    this.currentDisplayMode = format;
    this.updateButtonActiveStates();

    // Clean up previous scroll synchronization
    this.cleanupScrollSync();
    this.currentDiffContainer = container;

    container.innerHTML = Diff2Html.html(this.getDiffLines(), {
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
          <div class="d2h-wrapper d2h-${suffix}">
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

    // scroll synchronization for a side-by-side diff view
    if (format === 'side-by-side') {
      // Use setTimeout to ensure DOM elements are rendered
      setTimeout(() => this.setupScrollSynchronization(container), 0);
    }
  }

  /**
   * Sets up scroll synchronization for a side-by-side diff view.
   * Finds the scrollable wrapper elements for both columns and adds event listeners
   * to synchronize both vertical and horizontal scroll positions.
   *
   * @param {HTMLElement} container - The container element containing the diff
   */
  private setupScrollSynchronization(container: HTMLElement): void {
    const wrappers = container.querySelectorAll('.d2h-side-column-wrapper') as NodeListOf<HTMLElement>;

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

      requestAnimationFrame(() => {
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

      requestAnimationFrame(() => {
        isScrolling = false;
      });
    };

    // Add scroll event listeners
    leftWrapper.addEventListener('scroll', syncLeftToRight);
    rightWrapper.addEventListener('scroll', syncRightToLeft);

    // Store references for cleanup (if needed later)
    (container as HTMLElementWithScrollSync)._scrollSyncCleanup = (): void => {
      leftWrapper.removeEventListener('scroll', syncLeftToRight);
      rightWrapper.removeEventListener('scroll', syncRightToLeft);
    };
  }

  /**
   * Cleans up scroll synchronization event listeners.
   * Called when switching between diff modes or closing the modal.
   */
  private cleanupScrollSync(): void {
    if ((this.currentDiffContainer as HTMLElementWithScrollSync)?._scrollSyncCleanup) {
      (this.currentDiffContainer as HTMLElementWithScrollSync)._scrollSyncCleanup();
      delete (this.currentDiffContainer as HTMLElementWithScrollSync)._scrollSyncCleanup;
    }
  }
}
