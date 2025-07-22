import { ChangeType, IndicatorType } from '@/consts';
import { Inject } from '@/decorators/inject.decorator';
import { BaseExtension } from '@/extensions/base.extension';
import type { ChangeLine } from '@/lines/change.line';
import type { ArrayMap } from '@/maps/array.map';
import { RemovedMarker } from '@/markers/removed.marker';
import type { SettingsService } from '@/services/settings.service';
import type { SnapshotsService } from '@/services/snapshots.service';
import type { FileSnapshot } from '@/snapshots/file.snapshot';
import type { GutterConfig } from '@/types';
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

      if (removed.has(line.number - 1) && !removed.has(line.number - 2)) {
        builder.add(line.from, line.from, new RemovedMarker(this.plugin));
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
   * Checks if showing removed lines is enabled in settings.
   *
   * @return {boolean} True if showing removed lines is enabled, false otherwise
   */
  protected isEnable(): boolean {
    return this.settingsService.value('show.removed');
  }
}
