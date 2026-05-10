import { DiffOutputFormatType } from '@/consts';
import { Inject } from '@/decorators/inject.decorator';
import { BaseContentHelper } from '@/helpers/base-content.helper';
import { DomHelper } from '@/helpers/dom.helper';
import { HunkHelper } from '@/helpers/hunk.helper';
import { type NavigationDirection, NavigationHelper } from '@/helpers/navigation.helper';
import { type SearchableVersion, VersionSearchHelper } from '@/helpers/version-search.helper';
import { type InlineDiffLine, WordDiffHelper } from '@/helpers/word-diff.helper';
import type LineChangeTrackerPlugin from '@/main';
import type { ModalsService } from '@/services/modals.service';
import type { SnapshotsService } from '@/services/snapshots.service';
import type { FileSnapshot } from '@/snapshots/file.snapshot';
import type { FileVersion } from '@/snapshots/file.version';
import type { DomElementConfig, FunctionVoid, HTMLElementWithScrollSync } from '@/types';
import * as Diff from 'diff';
import * as Diff2Html from 'diff2html';
import { type App, type ButtonComponent, Modal, Notice, SearchComponent, Setting, type TFile } from 'obsidian';

/**
 * Sentinel id for the synthetic baseline entry in the version list. Picking it
 * diffs the current state against the LATEST captured snapshot, falling back to
 * the file's original captured content only when no snapshot exists (D1). Real
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
   * Left rail container of the three-pane shell. Hosts the version timeline
   * (and, in a later task, the content search above it).
   */
  protected railEl?: HTMLElement;

  /**
   * Top toolbar container of the three-pane shell. Hosts the view-mode and
   * action controls above the diff.
   */
  protected toolbarEl?: HTMLElement;

  /**
   * Main pane container of the three-pane shell. Hosts the toolbar and the diff
   * output. The next/previous navigation now walks the diff rows directly.
   */
  protected mainEl?: HTMLElement;

  /**
   * Container element holding the content-search box above the version list in
   * the left rail.
   */
  protected searchEl?: HTMLElement;

  /**
   * Container element holding the version timeline list, rebuilt to reflect the
   * selected base.
   */
  protected versionsEl?: HTMLElement;

  /**
   * Id of the currently selected diff base. Defaults to the original baseline;
   * may be set to an intermediate version's id to diff the current state against
   * that earlier point instead.
   */
  protected selectedBaseId: string = ORIGINAL_BASE_ID;

  /**
   * Current content-search query for the version rail. An empty string shows
   * every version; a non-empty query keeps only versions whose captured content
   * contains it (case-insensitive). It never affects the selected diff base.
   */
  protected searchQuery: string = '';

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
   * References to the next/previous difference navigation buttons, kept so they
   * can be disabled when the current diff has no hunks to walk.
   */
  protected navButtons: {
    /** Button that jumps to the previous difference */
    previous?: HTMLElement;
    /** Button that jumps to the next difference */
    next?: HTMLElement;
  } = {};

  /**
   * Index of the difference currently focused by the next/previous navigation,
   * or -1 when none is focused yet. It indexes into the hunks computed for the
   * selected base, and is reset whenever the diff changes (base switch, revert,
   * or content change) so a stale index can never highlight the wrong block.
   */
  protected activeHunkIndex: number = -1;

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
      const originalContent: string = this.snapshot.getHistoryOriginalState();
      const file: TFile = this.snapshot.file;

      await this.app.vault.modify(file, originalContent);
      this.snapshotsService.wipeOne(file);

      new Notice(this.plugin.t('notice.file-restored'));

      this.close();
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (_error) {
      new Notice(this.plugin.t('notice.file-restore-failed'));
    }
  }

  /**
   * Creates the UI elements for the diff view.
   */
  protected makeUI(): void {
    // Obsidian Settings-style shell: the body splits into a left navigation
    // column (the version rail) and a right content column. The content column
    // stacks the toolbar above the diff, so the rail runs full height on the
    // left and the toolbar plus diff fill the right.
    const bodyEl: HTMLElement = DomHelper.create({
      tag: 'div',
      classes: 'lct-modal-body',
      container: this.contentEl,
    });

    this.railEl = DomHelper.create({
      tag: 'div',
      classes: 'lct-modal-rail',
      container: bodyEl,
    });

    this.mainEl = DomHelper.create({
      tag: 'div',
      classes: 'lct-modal-main',
      container: bodyEl,
    });

    // The toolbar lives at the top of the right content column, above the diff.
    this.toolbarEl = DomHelper.create({
      tag: 'div',
      classes: 'lct-modal-toolbar',
      container: this.mainEl,
    });

    this.makeToolbar();

    // Content search sits above the version timeline in the left rail.
    this.searchEl = DomHelper.create({
      tag: 'div',
      classes: 'lct-rail-search',
      container: this.railEl,
    });

    // Version timeline lives in the left rail, under the search box.
    this.versionsEl = DomHelper.create({
      tag: 'div',
      classes: 'lct-versions',
      container: this.railEl,
    });

    // The diff output fills the rest of the right content column. Per-hunk
    // revert lives inline inside the diff rows, not in a separate panel.
    this.diffContainerEl = DomHelper.create({
      tag: 'div',
      classes: 'diff-container',
      container: this.mainEl,
    });

    this.renderSearch();
    this.renderVersions();
  }

  /**
   * Builds the top toolbar controls as icon buttons grouped by purpose: the
   * destructive actions (restore original, remove history), the difference
   * navigation, and the four view-mode toggles, all right-aligned in the toolbar.
   * Every button is icon-only on screen but carries a text label through its
   * tooltip and aria-label so it stays usable by keyboard and screen readers. The
   * view-mode buttons keep the active-mode highlight driven by
   * updateButtonActiveStates; the destructive actions still confirm before acting.
   */
  protected makeToolbar(): void {
    // Destructive actions: each still asks for confirmation before acting.
    new Setting(this.toolbarEl)
      .setClass('lct-modal-toolbar-group')
      .setClass('lct-modal-toolbar-actions')
      .addButton((btn: ButtonComponent): ButtonComponent =>
        this.decorateButton(btn, 'rotate-ccw', this.plugin.t('modal.restore-original'))
          .setWarning()
          .onClick(async (): Promise<void> => {
            const confirmed: boolean = await this.modalsService.confirm({
              title: this.plugin.t('modal.confirm.restore.title'),
              message: this.plugin.t('modal.confirm.restore.message'),
              confirmText: this.plugin.t('modal.confirm.restore.button'),
              cancelText: this.plugin.t('modal.confirm.cancel')
            });

            if (confirmed) {
              await this.restoreOriginalFile();
            }
          }))
      .addButton((btn: ButtonComponent): ButtonComponent =>
        this.decorateButton(btn, 'trash-2', this.plugin.t('modal.remove-history'))
          .setWarning()
          .onClick(async (): Promise<void> => {
            const confirmed: boolean = await this.modalsService.confirm({
              title: this.plugin.t('modal.confirm.remove.title'),
              message: this.plugin.t('modal.confirm.remove.message'),
              confirmText: this.plugin.t('modal.confirm.remove.button'),
              cancelText: this.plugin.t('modal.confirm.cancel')
            });

            if (confirmed) {
              this.snapshotsService?.wipeOne(this.snapshot.file);
              this.close();
            }
          }));

    // Difference navigation: step between the diff hunks with wrap-around. The
    // buttons are disabled when the current diff has no hunks.
    new Setting(this.toolbarEl)
      .setClass('lct-modal-toolbar-group')
      .setClass('lct-modal-toolbar-nav')
      .addButton((btn: ButtonComponent): ButtonComponent => {
        this.navButtons.previous = btn.buttonEl;

        return this.decorateButton(btn, 'chevron-up', this.plugin.t('modal.previous-difference'))
          .onClick((): void => {
            this.goToDifference('previous');
          });
      })
      .addButton((btn: ButtonComponent): ButtonComponent => {
        this.navButtons.next = btn.buttonEl;

        return this.decorateButton(btn, 'chevron-down', this.plugin.t('modal.next-difference'))
          .onClick((): void => {
            this.goToDifference('next');
          });
      });

    // View-mode toggles: the active mode is highlighted via mod-cta.
    new Setting(this.toolbarEl)
      .setClass('lct-modal-toolbar-group')
      .setClass('lct-modal-toolbar-modes')
      .addButton((btn: ButtonComponent): ButtonComponent => {
        this.modeButtons.patch = btn.buttonEl;

        return this.decorateButton(btn, 'file-text', this.plugin.t('modal.mode.patch'))
          .onClick((): void => {
            this.showCleanPatch();
          });
      })
      .addButton((btn: ButtonComponent): ButtonComponent => {
        this.modeButtons.inline = btn.buttonEl;

        return this.decorateButton(btn, 'pilcrow', this.plugin.t('modal.mode.inline'))
          .onClick((): void => {
            this.renderInlineDiff();
          });
      })
      .addButton((btn: ButtonComponent): ButtonComponent => {
        this.modeButtons.lineByLine = btn.buttonEl;

        return this.decorateButton(btn, 'align-justify', this.plugin.t('modal.mode.line-by-line'))
          .onClick((): void => {
            this.renderDiff(DiffOutputFormatType.line);
          });
      })
      .addButton((btn: ButtonComponent): ButtonComponent => {
        this.modeButtons.sideBySide = btn.buttonEl;

        return this.decorateButton(btn, 'columns-2', this.plugin.t('modal.mode.side-by-side'))
          .onClick((): void => {
            this.renderDiff(DiffOutputFormatType.side);
          });
      });

    // Set the initial active state.
    this.updateButtonActiveStates();
  }

  /**
   * Turns a toolbar button into an accessible icon button: it shows only the
   * icon but exposes the label as both a hover tooltip and an aria-label, so the
   * control is never a label-less icon for keyboard or screen-reader users.
   *
   * @param {ButtonComponent} btn - The button to decorate
   * @param {string} icon - The Obsidian (Lucide) icon id to render
   * @param {string} label - The text label exposed via tooltip and aria-label
   * @return {ButtonComponent} The same button, for chaining
   */
  protected decorateButton(btn: ButtonComponent, icon: string, label: string): ButtonComponent {
    btn
      .setIcon(icon)
      .setTooltip(label);

    btn.buttonEl.setAttribute('aria-label', label);

    return btn;
  }

  /**
   * Moves the difference focus to the next or previous hunk and brings it into
   * view. The target index is resolved by the same pure NavigationHelper.target
   * used by the editor change-navigation commands, fed the hunk indices as the
   * "changed lines" and the current active index as the cursor, so the walk
   * wraps around at both ends (past the last hunk returns to the first, before
   * the first returns to the last). With no hunks it is a safe no-op.
   *
   * @param {NavigationDirection} direction - Which way to step through the hunks
   */
  protected goToDifference(direction: NavigationDirection): void {
    const count: number = this.getHunks().length;

    if (count === 0) {
      return;
    }

    // Hunk indices are 0..count-1; reuse the cursor-based target picker over
    // them so the wrap-around behaviour matches the editor navigation exactly.
    const indices: number[] = Array.from({ length: count }, (_unused: unknown, index: number): number => index);
    const target: number | null = NavigationHelper.target(indices, this.activeHunkIndex, direction);

    if (target === null) {
      return;
    }

    this.activeHunkIndex = target;
    this.focusHunk(target);
  }

  /**
   * Highlights the hunk at the given index inside the diff and scrolls it into
   * view, so the difference the navigation buttons moved to is visible and
   * marked active. The target is the hunk's anchor row inside the rendered diff
   * (the same row that carries the inline revert affordance), so navigation
   * works against the diff itself now that the separate difference panel is
   * gone. Every other anchor row loses the active marker first. Patch mode has
   * no per-row anchors, so this is a safe no-op there.
   *
   * @param {number} index - The hunk index to focus
   */
  protected focusHunk(index: number): void {
    if (!this.diffContainerEl) {
      return;
    }

    const anchors: HTMLElement[] = Array.from(
      this.diffContainerEl.querySelectorAll<HTMLElement>('.lct-hunk-anchor'),
    );

    anchors.forEach((anchor: HTMLElement): void => {
      const anchorIndex: number = Number(anchor.dataset.lctHunk);

      DomHelper.update(anchor, { classes: anchorIndex === index ? { add: 'is-active' } : { remove: 'is-active' } });
    });

    anchors
      .find((anchor: HTMLElement): boolean => Number(anchor.dataset.lctHunk) === index)
      ?.scrollIntoView({ block: 'nearest' });
  }

  /**
   * Enables or disables the next/previous difference buttons based on whether
   * the current diff has any hunks to walk, and drops a stale active index when
   * the diff no longer has that many hunks. A diff with zero hunks leaves both
   * buttons disabled so a click is an ignored no-op.
   */
  protected updateNavButtonsState(): void {
    const count: number = this.getHunks().length;
    const disabled: boolean = count === 0;

    [this.navButtons.previous, this.navButtons.next].forEach((button: HTMLElement | undefined): void => {
      if (!button) {
        return;
      }

      (button as HTMLButtonElement).disabled = disabled;
      DomHelper.update(button, { classes: disabled ? { add: 'is-disabled' } : { remove: 'is-disabled' } });
    });

    // Forget a focus that no longer points at an existing hunk.
    if (this.activeHunkIndex >= count) {
      this.activeHunkIndex = -1;
    }
  }

  /**
   * Renders the content-search box above the version list. The box filters the
   * intermediate versions in the rail by their captured content. It is always
   * shown so the rail stays consistent even before any version exists; with no
   * versions a query simply matches nothing. Typing re-renders only the version
   * list (not the diff or the selection).
   */
  protected renderSearch(): void {
    if (!this.searchEl) {
      return;
    }

    DomHelper.update(this.searchEl, { text: null, classes: { remove: 'lct-rail-search-empty' } });

    new SearchComponent(this.searchEl)
      .setPlaceholder(this.plugin.t('modal.search-versions'))
      .setValue(this.searchQuery)
      .onChange((value: string): void => {
        this.searchQuery = value;
        this.renderVersions();
      });
  }

  /**
   * Renders the version timeline as a list of selectable diff bases. The list
   * always starts with the baseline entry (the original compared against the
   * current state), which carries the file's last-changed time, followed by
   * intermediate versions newest first that match the current search query. The
   * rail is never hidden: with no intermediate versions it shows the baseline
   * plus a hint that none were captured yet; when a query matches no version it
   * shows the baseline plus a no-results hint, leaving the current selection
   * untouched. Selecting an entry sets it as the diff base and re-renders the
   * active view.
   */
  protected renderVersions(): void {
    if (!this.versionsEl) {
      return;
    }

    const versions: FileVersion[] = this.snapshot.getVersions();

    // The rail is always visible: even a timeline-less file offers the baseline
    // (original vs current) entry, so the block is never collapsed.
    DomHelper.update(this.versionsEl, { classes: { remove: 'lct-versions-empty' } });

    const visibleIds: Set<string> = VersionSearchHelper.match(
      versions.map((version: FileVersion): SearchableVersion => ({
        id: version.id,
        content: version.getContent(this.snapshot.lineBreak),
      })),
      this.searchQuery,
    );

    const matched: FileVersion[] = versions.filter((version: FileVersion): boolean => visibleIds.has(version.id));

    // The baseline entry compares the original against the current state and
    // always heads the list, carrying the file's last-changed time. Version
    // numbers stay tied to the full timeline position so they do not shift while
    // filtering.
    const items: DomElementConfig[] = [
      this.makeVersionItem(
        ORIGINAL_BASE_ID,
        this.plugin.t('modal.version.baseline'),
        this.snapshot.getLastChangedDateTime(),
      ),
      ...matched.map((version: FileVersion): DomElementConfig => {
        const number: number = versions.length - versions.indexOf(version);

        return this.makeVersionItem(
          version.id,
          this.plugin.t('modal.version.numbered', { number }),
          version.getDateTime(),
        );
      }),
    ];

    // Informative empty states under the baseline: no intermediate snapshots
    // captured at all, or a search that excluded every existing version.
    if (versions.length === 0) {
      items.push({
        tag: 'div',
        classes: 'lct-versions-no-results',
        text: this.plugin.t('modal.no-snapshots-yet'),
      });
    } else if (matched.length === 0) {
      items.push({
        tag: 'div',
        classes: 'lct-versions-no-results',
        text: this.plugin.t('modal.no-versions-match'),
      });
    }

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
   * Resolves the content of the currently selected diff base. A picked
   * intermediate version resolves to that version's captured content. The
   * synthetic baseline entry (or a stale id whose version no longer exists)
   * resolves to the LATEST captured snapshot, falling back to the original only
   * when no snapshot exists (D1). The branch logic lives in the pure
   * BaseContentHelper so it can be unit-tested without the modal DOM.
   *
   * @return {string} The base content to diff the current state against
   */
  protected getBaseContent(): string {
    return BaseContentHelper.resolve(this.selectedBaseId, ORIGINAL_BASE_ID, {
      versions: this.snapshot
        .getVersions()
        .map((version: FileVersion): string => version.getContent(this.snapshot.lineBreak)),
      original: this.snapshot.getHistoryOriginalState(),
      versionContent: (id: string): string | null =>
        this.snapshot.getVersion(id)?.getContent(this.snapshot.lineBreak) ?? null,
    });
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
   * Picks the placeholder text shown when the selected base equals the current
   * state. A picked intermediate version that matches the live content reads
   * "Identical to current" so the user understands the chosen base holds the
   * same text, distinguishing it from the original-vs-current "No changes" case
   * where the file simply was never modified.
   *
   * @return {string} The empty-diff placeholder text for the current base
   */
  protected getEmptyDiffText(): string {
    return this.selectedBaseId === ORIGINAL_BASE_ID
      ? this.plugin.t('modal.no-changes')
      : this.plugin.t('modal.identical-to-current');
  }

  /**
   * Computes the line-level hunks between the selected base and the current
   * state. These back the inline per-hunk revert affordances and the
   * next/previous navigation, and are recomputed on demand so the offsets always
   * reflect the live content.
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
   * Reverts a single hunk of the current diff back to the selected base and
   * leaves every other change intact. The hunk is resolved fresh from getHunks
   * (against the live content) by its index, the user confirms before the write,
   * and the revert reuses the same plumbing the editor gutter uses: HunkHelper to
   * scope the block, SnapshotsService.applyContent to write it and refresh the
   * highlights. The active view is then re-rendered so the diff reflects the new
   * content. A stale index (the diff changed under the click) is a safe no-op.
   *
   * @param {number} index - The index of the hunk to revert in the current diff
   * @return {Promise<void>}
   */
  protected async revertHunk(index: number): Promise<void> {
    const file: TFile | undefined = this.snapshot?.file;

    if (!file) {
      return;
    }

    const hunk: Diff.StructuredPatchHunk | undefined = this.getHunks()[index];

    if (!hunk) {
      return;
    }

    const confirmed: boolean = await this.modalsService.confirm({
      title: this.plugin.t('modal.confirm.revert.title'),
      message: this.plugin.t('modal.confirm.revert.message'),
      confirmText: this.plugin.t('modal.confirm.revert.button'),
      cancelText: this.plugin.t('modal.confirm.cancel'),
    });

    if (!confirmed) {
      return;
    }

    const currentLines: string[] = this.snapshot.getLastStateLines();
    const start: number = Math.max(0, Math.min(currentLines.length, hunk.newStart - 1));

    await this.snapshotsService.applyContent(
      file,
      HunkHelper.revertHunk(currentLines, hunk),
      {
        start,
        removeCount: hunk.newLines,
        newLines: HunkHelper.baseLinesForHunk(hunk),
      },
    );

    // The content changed, so the diff (and its hunk indices) is stale: drop the
    // navigation focus and redraw the active view, which re-attaches the inline
    // revert affordances against the new hunks.
    this.activeHunkIndex = -1;
    this.refreshActiveView();
  }

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
  protected attachInlineReverts(): void {
    if (!this.diffContainerEl) {
      return;
    }

    const hunks: Diff.StructuredPatchHunk[] = this.getHunks();

    hunks.forEach((hunk: Diff.StructuredPatchHunk, index: number): void => {
      const anchor: HTMLElement | null = this.resolveHunkAnchor(hunk);

      if (!anchor) {
        return;
      }

      anchor.classList.add('lct-hunk-anchor');
      anchor.dataset.lctHunk = String(index);

      DomHelper.update(anchor, {
        children: [this.makeRevertAffordance(index)],
      });
    });

    this.updateNavButtonsState();
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
    if (this.currentDisplayMode === 'inline') {
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
      this.diffContainerEl.querySelectorAll<HTMLElement>('.lct-inline-row'),
    );

    // Walk the rows tracking the current-side line number: a context or added
    // row advances it, a removed row does not. The anchor is the first changed
    // row whose current-side position reaches the hunk's newStart. A pure
    // deletion (newLines === 0) sits between current lines, so it anchors on the
    // first changed row at or after newStart.
    let currentLine: number = 0;

    for (const row of rows) {
      const changed: boolean = !row.classList.contains('lct-inline-context');
      const added: boolean = row.classList.contains('lct-inline-added');

      if (changed && currentLine + 1 >= hunk.newStart) {
        return row;
      }

      if (!changed || added) {
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
    const sideBySide: boolean = this.currentDisplayMode === 'side-by-side';
    const columns: HTMLElement[] = sideBySide
      ? Array.from(this.diffContainerEl.querySelectorAll<HTMLElement>('.d2h-side-column'))
      : [];

    if (hunk.newLines > 0) {
      const newScope: ParentNode = sideBySide ? columns[1] ?? this.diffContainerEl : this.diffContainerEl;

      return this.rowAtLine(newScope, hunk.newStart);
    }

    // Pure deletion: in side-by-side the removed lines live in the left column,
    // keyed by the hunk's oldStart; in line-by-line they are d2h-del rows in the
    // single stream, anchored by the first one at or after the deletion point.
    if (sideBySide) {
      return this.rowAtLine(columns[0] ?? this.diffContainerEl, hunk.oldStart);
    }

    const rows: HTMLElement[] = this.codeRows(this.diffContainerEl);

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
   * Builds the inline revert affordance for a hunk: an accessible icon button
   * carrying a tooltip and aria-label, which reverts only that hunk on click.
   *
   * @param {number} index - The hunk index the affordance reverts
   * @return {DomElementConfig} The affordance element config
   */
  protected makeRevertAffordance(index: number): DomElementConfig {
    const label: string = this.plugin.t('modal.revert-hunk');

    return {
      tag: 'button',
      classes: ['lct-hunk-revert', 'clickable-icon'],
      attributes: { 'aria-label': label, 'title': label, 'type': 'button' },
      children: [{ tag: 'span', classes: 'lct-hunk-revert-icon', text: '↩' }],
      events: {
        click: (event: Event): void => {
          event.preventDefault();
          event.stopPropagation();
          void this.revertHunk(index);
        },
      },
    };
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
        new Notice(this.plugin.t('notice.copied'));
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
                text: this.plugin.t('modal.copy'),
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

    // Patch mode has no per-row structure for inline revert, but the navigation
    // buttons still reflect whether the current diff has any hunks to walk.
    this.updateNavButtonsState();
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
        children: [{ tag: 'div', classes: 'lct-inline-empty', text: this.getEmptyDiffText() }],
      });

      // No diff, so no hunks: the navigation buttons stay disabled.
      this.updateNavButtonsState();

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

    // Map the rendered inline rows back to hunks and place the per-hunk revert
    // affordances; this also refreshes the navigation button state.
    this.attachInlineReverts();
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

    // Map the rendered diff2html rows back to hunks and place the per-hunk
    // revert affordances; this also refreshes the navigation button state.
    this.attachInlineReverts();

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
