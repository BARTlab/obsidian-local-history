import { ChangeType, IndicatorType } from '@/consts';
import { Inject } from '@/decorators/inject.decorator';
import { BaseExtension } from '@/extensions/base.extension';
import { HunkHelper } from '@/helpers/hunk.helper';
import type { ChangeLine } from '@/lines/change.line';
import type { ArrayMap } from '@/maps/array.map';
import { DotMarker } from '@/markers/char.marker';
import type { ModalsService } from '@/services/modals.service';
import type { SettingsService } from '@/services/settings.service';
import type { SnapshotsService } from '@/services/snapshots.service';
import type { FileSnapshot } from '@/snapshots/file.snapshot';
import type { GutterConfig } from '@/types';
import type * as Diff from 'diff';
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
  @Inject('SettingsService')
  protected settingsService: SettingsService;

  /**
   * Service for managing file snapshots.
   * Injected using the @Inject decorator.
   */
  @Inject('SnapshotsService')
  protected snapshotsService: SnapshotsService;

  /**
   * Service for confirmation dialogs.
   * Injected using the @Inject decorator.
   */
  @Inject('ModalsService')
  protected modalsService: ModalsService;

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
   * Creates markers for the gutter-based online changes.
   * Returns a RangeSet of DotMarker instances for lines with changes.
   *
   * @param {EditorView} view - The editor view to create markers for
   * @return {RangeSet<DotMarker>} A RangeSet of DotMarker instances
   */
  public markers = (view: EditorView): RangeSet<DotMarker> => {
    const enable: ChangeType[] = this.getEnableTypes();
    const snapshot: FileSnapshot | null = this.snapshotsService.getOne();
    const changes: ArrayMap<ChangeLine> | null = snapshot?.getChanges(enable) ?? null;
    const builder = new RangeSetBuilder<DotMarker>();

    if (!this.isTypeDot() || !snapshot || !changes?.size) {
      return builder.finish();
    }

    for (let i: number = 0; i <= view.state.doc.lines - 1; i++) {
      const line: Line = view.state.doc.line(i + 1);
      const change: ChangeLine = changes.get(i);

      if (change) {
        builder.add(line.from, line.from, new DotMarker(
          change.getModify(),
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
   * the user confirms before the write, and the revert reuses the same plumbing
   * as the history modal (HunkHelper to scope the block, SnapshotsService to
   * apply it), which refreshes the editor highlights.
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

    const confirmed: boolean = await this.modalsService.confirm({
      title: 'Revert change',
      message: 'Revert this change back to the original? Other changes are kept.',
      confirmText: 'Revert',
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
   * Gets the enabled change types from settings.
   * Includes only the types that are enabled in the settings.
   * Note: Unlike editor extension, this doesn't include 'removed' type
   * as removed lines are handled separately.
   *
   * @return {ChangeType[]} Array of enabled change types
   */
  protected getEnableTypes(): ChangeType[] {
    return [
      ...this.settingsService.value('show.changed') ? [ChangeType.changed] : [],
      ...this.settingsService.value('show.restored') ? [ChangeType.restored] : [],
      ...this.settingsService.value('show.added') ? [ChangeType.added] : [],
    ];
  }
}
