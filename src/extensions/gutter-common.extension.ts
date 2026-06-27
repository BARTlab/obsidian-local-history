import { ChangeType, IndicatorType } from '@/consts';
import { Inject } from '@/decorators/inject.decorator';
import { BaseExtension } from '@/extensions/base.extension';
import { confirmAndRevertHunk } from '@/helpers/hunk-revert.helper';
import { HunkHelper } from '@/helpers/hunk.helper';
import type { ChangeLine } from '@/lines/change.line';
import type { ArrayMap } from '@/maps/array.map';
import { DotMarker } from '@/markers/char.marker';
import type { ModalsService } from '@/services/modals.service';
import type { SettingsService } from '@/services/settings.service';
import type { SnapshotsService } from '@/services/snapshots.service';
import { TOKENS } from '@/services/tokens';
import type { FileSnapshot } from '@/snapshots/file.snapshot';
import type { GutterConfig, Handlers } from '@/types';
import type * as Diff from 'diff';
import { Menu } from 'obsidian';
import type { BlockInfo } from '@codemirror/view';
import type { Line, RangeSet } from '@codemirror/state';
import { RangeSetBuilder } from '@codemirror/state';
import { type EditorView } from '@codemirror/view';

/**
 * Extension that adds dot markers to the editor gutter based on change status.
 * Shows dots in the gutter for lines that have been added, modified, or restored.
 *
 * @implements {GutterConfig}
 * @extends {BaseExtension}
 */
export class GutterCommonExtension extends BaseExtension implements GutterConfig {
  /**
   * Service for accessing plugin settings.
   * Injected using the @Inject decorator.
   */
  @Inject(TOKENS.settings)
  protected settingsService!: SettingsService;

  /**
   * Service for managing file snapshots.
   * Injected using the @Inject decorator.
   */
  @Inject(TOKENS.snapshots)
  protected snapshotsService!: SnapshotsService;

  /**
   * Service for confirmation dialogs.
   * Injected using the @Inject decorator.
   */
  @Inject(TOKENS.modals)
  protected modalsService!: ModalsService;

  /**
   * CSS class for the gutter element.
   * Combines the base plugin class with the dot indicator type.
   */
  public class: string = `lct lct-gutter lct-${IndicatorType.dot}`;

  /**
   * Whether to render empty elements in the gutter.
   * Set too false to only show markers for lines with changes.
   */
  public renderEmptyElements: boolean = false;

  /**
   * DOM event handlers for this gutter. Obsidian exposes no gutter-specific
   * context-menu event, so the gutter `contextmenu` is captured here (it fires
   * only on the gutter DOM, leaving the general editor menu untouched) to open a
   * gutter-specific Obsidian menu. CodeMirror owns the listener lifecycle, so it
   * is removed automatically when the registered editor extension unloads.
   */
  public domEventHandlers: Handlers = {
    contextmenu: (_view: EditorView, _line: BlockInfo, event: Event): boolean => {
      this.openGutterMenu(event as MouseEvent);

      return true;
    },
  };

  /**
   * Creates markers for the gutter-based online changes.
   * Returns a RangeSet of DotMarker instances for lines with changes.
   *
   * @param {EditorView} view - The editor view to create markers for
   * @return {RangeSet<DotMarker>} A RangeSet of DotMarker instances
   */
  public markers = (view: EditorView): RangeSet<DotMarker> => {
    const enable: ChangeType[] = this.settingsService
      .getEnabledTypes()
      .filter((type: ChangeType): boolean => type !== ChangeType.removed);

    const snapshot: FileSnapshot | null = this.snapshotsService.getOne();
    const changes: ArrayMap<ChangeLine> | null = snapshot?.getChanges(enable) ?? null;
    const builder = new RangeSetBuilder<DotMarker>();

    if (!this.isTypeDot() || !snapshot || !changes?.size) {
      return builder.finish();
    }

    for (let i: number = 0; i <= view.state.doc.lines - 1; i++) {
      const line: Line = view.state.doc.line(i + 1);
      const change: ChangeLine | undefined = changes.get(i);

      if (change) {
        // getModify() is non-null when a positive change type is present;
        // the dot marker is only added for lines with a modify type.
        const modify: ChangeType | null = change.getModify();

        if (modify === null) {
          continue;
        }

        builder.add(line.from, line.from, new DotMarker(
          modify,
          this.plugin,
          i,
          (target: number): void => {
            void this.revertBlockAt(target);
          },
        ));
      }
    }

    return builder.finish();
  };

  /**
   * Reverts the single changed block sitting at the given 0-based current line
   * back to the original baseline, leaving every other change intact. The hunks
   * are recomputed against the live content so the resolved block is never stale,
   * then the block is handed to the shared confirm-and-revert helper the history
   * modal also uses (confirm, scope the block, apply, refresh the highlights).
   *
   * @param {number} line - The 0-based current line the affordance was clicked on
   * @return {Promise<void>}
   */
  protected async revertBlockAt(line: number): Promise<void> {
    const snapshot: FileSnapshot | null = this.snapshotsService.getOne();

    if (!snapshot?.file) {
      return;
    }

    const currentLines: string[] = snapshot.getLastStateLines();
    const hunks: Diff.StructuredPatchHunk[] = HunkHelper.diff(
      snapshot.getOriginalStateLines(),
      currentLines,
      snapshot.lineBreak,
    );

    const hunk: Diff.StructuredPatchHunk | null = HunkHelper.hunkAtLine(hunks, line);

    if (!hunk) {
      return;
    }

    await confirmAndRevertHunk({
      modalsService: this.modalsService,
      snapshotsService: this.snapshotsService,
      plugin: this.plugin,
      file: snapshot.file,
      currentLines,
      hunk,
    });
  }

  /**
   * Opens the gutter-specific context menu at the click position, prevents the
   * native browser menu, and adds a single "show changes" toggle bound to the
   * `show.*` settings. Built by hand because Obsidian has no gutter context-menu
   * API.
   *
   * @param {MouseEvent} event - The captured gutter `contextmenu` event
   * @return {void}
   */
  protected openGutterMenu(event: MouseEvent): void {
    event.preventDefault();

    const menu: Menu = new Menu();
    const shown: boolean = this.settingsService.isShowChangesEnabled();

    menu.addItem((item): void => {
      item
        .setTitle(this.plugin.t('menu.show-changes'))
        .setIcon('eye')
        .setChecked(shown)
        .onClick((): void => {
          this.settingsService.toggleShowChanges(!shown);
        });
    });

    menu.showAtMouseEvent(event);
  }

  /**
   * Checks if the indicator type is set to 'dot'.
   *
   * @return {boolean} True if the indicator type is 'dot', false otherwise
   */
  protected isTypeDot(): boolean {
    return this.settingsService.value('type') === IndicatorType.dot;
  }
}
