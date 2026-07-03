import { ChangeType, IndicatorType } from '@/consts';
import { Inject } from '@/decorators/inject.decorator';
import { confirmAndRevertHunk } from '@/helpers/hunk-revert.helper';
import * as HunkHelper from '@/helpers/hunk.helper';
import { isNestedEditor } from '@/helpers/nested-editor.helper';
import type { ChangeLine } from '@/lines/change.line';
import type LineChangeTrackerPlugin from '@/main';
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
 */
export class GutterRemovedExtension implements GutterConfig {
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

  @Inject(TOKENS.settings)
  protected settingsService!: SettingsService;

  @Inject(TOKENS.snapshots)
  protected snapshotsService!: SnapshotsService;

  @Inject(TOKENS.modals)
  protected modalsService!: ModalsService;

  public constructor(
    protected view: EditorView | null,
    public plugin: LineChangeTrackerPlugin,
  ) {
  }

  /**
   * Creates markers for the gutter to indicate removed lines.
   * Returns a RangeSet of RemovedMarker instances for positions where lines were removed.
   *
   * @param {EditorView} view - The editor view to create markers for
   * @return {RangeSet<RemovedMarker>} A RangeSet of RemovedMarker instances
   */
  public markers = (view: EditorView): RangeSet<RemovedMarker> => {
    const snapshot: FileSnapshot | null = this.snapshotsService.getOne();
    const removed: ArrayMap<ChangeLine> | null = snapshot?.content.getChanges(ChangeType.removed) ?? null;
    const builder: RangeSetBuilder<RemovedMarker> = new RangeSetBuilder<RemovedMarker>();

    // Snapshot positions are file lines; a nested cell editor's doc is only
    // the cell text, so any marker rendered there would be misplaced.
    if (isNestedEditor(view) || !this.isTypeDot() || !this.isEnable() || !snapshot || !removed || removed.size === 0) {
      return builder.finish();
    }

    for (const pos of snapshot.content.getChangedPositions(ChangeType.removed)) {
      if (pos >= view.state.doc.lines || removed.has(pos - 1)) {
        continue;
      }

      const line: Line = view.state.doc.line(pos + 1);

      builder.add(line.from, line.from, new RemovedMarker(
        this.plugin,
        pos,
        (target: number): void => {
          void this.revertRemovedAt(target);
        },
      ));
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

    const currentLines: string[] = snapshot.content.getLastStateLines();
    const hunks: Diff.StructuredPatchHunk[] = HunkHelper.diff(
      snapshot.content.getOriginalStateLines(),
      currentLines,
      snapshot.content.lineBreak,
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

    await confirmAndRevertHunk({
      modalsService: this.modalsService,
      snapshotsService: this.snapshotsService,
      plugin: this.plugin,
      file: snapshot.file,
      currentLines,
      hunk,
      cancelText: this.plugin.t('modal.confirm.cancel'),
    });
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
