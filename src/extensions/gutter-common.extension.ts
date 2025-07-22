import { ChangeType, IndicatorType } from '@/consts';
import { Inject } from '@/decorators/inject.decorator';
import { BaseExtension } from '@/extensions/base.extension';
import type { ChangeLine } from '@/lines/change.line';
import type { ArrayMap } from '@/maps/array.map';
import { DotMarker } from '@/markers/char.marker';
import type { SettingsService } from '@/services/settings.service';
import type { SnapshotsService } from '@/services/snapshots.service';
import type { FileSnapshot } from '@/snapshots/file.snapshot';
import type { GutterConfig } from '@/types';
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
        builder.add(line.from, line.from, new DotMarker(change.getModify(), this.plugin));
      }
    }

    return builder.finish();
  };

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
