import { ChangeType, IndicatorType } from '@/consts';
import { Inject } from '@/decorators/inject.decorator';
import { BaseExtension } from '@/extensions/base.extension';
import { HunkHelper } from '@/helpers/hunk.helper';
import type { ChangeLine } from '@/lines/change.line';
import type { ArrayMap } from '@/maps/array.map';
import { RemovedMarker } from '@/markers/removed.marker';
import type { ModalsService } from '@/services/modals.service';
import type { SettingsService } from '@/services/settings.service';
import type { SnapshotsService } from '@/services/snapshots.service';
import { TOKENS } from '@/services/tokens';
import type { FileSnapshot } from '@/snapshots/file.snapshot';
import type { GutterConfig } from '@/types';
import type * as Diff from 'diff';
import { type Line, type RangeSet, RangeSetBuilder } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

/**
 * Extension that adds markers to the editor gutter for removed lines.
 * Shows special markers in the gutter to indicate where lines have been removed.
 *
 * @implements {GutterConfig}
 * @extends {BaseExtension}
 */
export class GutterRemovedExtension extends BaseExtension implements GutterConfig {
  /**
   * Service for accessing plugin settings.
   * Injected using the @Inject decorator.
   */
  @Inject(TOKENS.settings)
  protected settingsService: SettingsService;

  /**
   * Service for managing file snapshots.
   * Injected using the @Inject decorator.
   */
  @Inject(TOKENS.snapshots)
  protected snapshotsService: SnapshotsService;

  /**
   * Service for confirmation dialogs.
   * Injected using the @Inject decorator.
   */
  @Inject(TOKENS.modals)
  protected modalsService: ModalsService;

  /**
   * CSS class for the gutter element.
   * Combines the base plugin class with the dot indicator type and remove a change type.
   */
  public class: string = `lct lct-gutter lct-${IndicatorType.dot} lct-${ChangeType.removed}`;

  /**
   * Whether to render empty elements in the gutter.
   * Set too false to only show markers for lines with changes.
   */
  public renderEmptyElements: boolean = false;

  /**
   * Creates markers for the gutter to indicate removed lines.
   * Returns a RangeSet of RemovedMarker instances for positions where lines were removed.
   *
   * @param {EditorView} view - The editor view to create markers for
   * @return {RangeSet<RemovedMarker>} A RangeSet of RemovedMarker instances
   */
  public markers = (view: EditorView): RangeSet<RemovedMarker> => {
    const snapshot: FileSnapshot | null = this.snapshotsService.getOne();
    const removed: ArrayMap<ChangeLine> | null = snapshot?.getChanges(ChangeType.removed) ?? null;
    const builder: RangeSetBuilder<RemovedMarker> = new RangeSetBuilder<RemovedMarker>();

    if (!this.isTypeDot() || !this.isEnable() || !snapshot || !removed || removed.size === 0) {
      return builder.finish();
    }

    for (let i: number = 1; i <= view.state.doc.lines; i++) {
      const line: Line = view.state.doc.line(i);

      if (removed.has(line.number - 1) && (line.number < 2 || !removed.has(line.number - 2))) {
        const currentLine: number = line.number - 1;

        builder.add(line.from, line.from, new RemovedMarker(
          this.plugin,
          currentLine,
          (target: number): void => {
            void this.revertRemovedAt(target);
          },
        ));
      }
    }

    return builder.finish();
  };

  /**
   * Reverts a removed-line deletion directly from the gutter without opening
   * the history modal. Finds the pure-deletion hunk whose insertion point
   * matches the given 0-based current line, prompts the user to confirm, then
   * applies the revert through the same plumbing used by the history modal
   * (HunkHelper + SnapshotsService.applyContent).
   *
   * A removed-line marker sits at the first current line after the deletion
   * gap, so the hunk's 1-based newStart equals currentLine + 1. A stale index
   * (no matching hunk in the live diff) is a safe no-op.
   *
   * @param {number} currentLine - The 0-based current line the marker sits on
   * @return {Promise<void>}
   */
  protected async revertRemovedAt(currentLine: number): Promise<void> {
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

    /**
     * Pure-deletion hunks have newLines === 0; their newStart is the 1-based
     * insertion point - the line before which the removed content would be
     * reinserted. The gutter marker is placed on the line at currentLine
     * (0-based), which is line.number - 1 from the doc. That maps to
     * newStart = currentLine + 1.
     */
    const insertionPoint: number = currentLine + 1;
    const hunk: Diff.StructuredPatchHunk | undefined = hunks.find(
      (h: Diff.StructuredPatchHunk): boolean => h.newLines === 0 && h.newStart === insertionPoint,
    );

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

    const start: number = Math.max(0, Math.min(currentLines.length, hunk.newStart - 1));

    await this.snapshotsService.applyContent(
      snapshot.file,
      HunkHelper.revertHunk(currentLines, hunk),
      {
        start,
        removeCount: hunk.newLines,
        newLines: HunkHelper.baseLinesForHunk(hunk),
      },
    );
  }

  /**
   * Checks if the indicator type is set to 'dot'.
   *
   * @return {boolean} True if the indicator type is 'dot', false otherwise
   */
  protected isTypeDot(): boolean {
    return this.settingsService.value('type') === IndicatorType.dot;
  }

  /**
   * Checks if showing removed lines is enabled in settings.
   *
   * @return {boolean} True if showing removed lines is enabled, false otherwise
   */
  protected isEnable(): boolean {
    return this.settingsService.value('show.removed');
  }
}
