import { ChangeType, IndicatorType } from '@/consts';
import { Inject } from '@/decorators/inject.decorator';
import type { ChangeLine } from '@/lines/change.line';
import type LineChangeTrackerPlugin from '@/main';
import type { ArrayMap } from '@/maps/array.map';
import { BarMarker } from '@/markers/bar.marker';
import type { SettingsService } from '@/services/settings.service';
import type { SnapshotsService } from '@/services/snapshots.service';
import { TOKENS } from '@/services/tokens';
import type { FileSnapshot } from '@/snapshots/file.snapshot';
import type { GutterConfig } from '@/types';
import { type Line, type RangeSet, RangeSetBuilder } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

/**
 * Draws the `line` change bar inside its own gutter column, placed before the
 * line-number gutter. Replaces the former `.cm-line` margin bar: a real gutter
 * marker never shares pseudo-elements with the theme's blockquote marker, so the
 * quote-line special-casing the margin bar needed disappears, and a gutter
 * element naturally covers Live Preview block widgets (tables, callouts, embeds)
 * that the per-line decoration could not reach.
 *
 * One marker per changed line. A line carrying a positive change renders a bar
 * of that kind; a pure removed-anchor renders a removed dash. Mirrors
 * {@link ChangeLine#getModify}: removed is dropped when a positive kind is
 * present so a single line never stacks two markers.
 *
 * @implements {GutterConfig}
 */
export class GutterBarExtension implements GutterConfig {
  /** CSS class for the gutter wrapper element. */
  public class: string = `lct lct-gutter-bar-col lct-${IndicatorType.line}`;

  /**
   * Only render elements for changed lines, so unchanged lines leave no filler
   * and the column reads as discrete strokes per change run.
   */
  public renderEmptyElements: boolean = false;

  /** Service for accessing plugin settings. */
  @Inject(TOKENS.settings)
  protected settingsService!: SettingsService;

  /** Service for managing file snapshots. */
  @Inject(TOKENS.snapshots)
  protected snapshotsService!: SnapshotsService;

  public constructor(
    protected view: EditorView | null,
    public plugin: LineChangeTrackerPlugin,
  ) {
  }

  /**
   * Builds one bar marker for every changed line in the current snapshot.
   *
   * @param {EditorView} view - The editor view
   * @return {RangeSet<BarMarker>} The bar markers
   */
  public markers = (view: EditorView): RangeSet<BarMarker> => {
    const enable: ChangeType[] = this.settingsService.getEnabledTypes();
    const snapshot: FileSnapshot | null = this.snapshotsService.getOne();
    const changes: ArrayMap<ChangeLine> | null = snapshot?.content.getChanges(enable) ?? null;
    const builder = new RangeSetBuilder<BarMarker>();

    if (!this.isTypeLine() || !snapshot || !changes?.size) {
      return builder.finish();
    }

    for (const pos of snapshot.content.getChangedPositions(enable)) {
      if (pos >= view.state.doc.lines) {
        continue;
      }

      const change: ChangeLine | undefined = changes.get(pos);

      if (!change) {
        continue;
      }

      /**
       * A removed anchor can collapse onto a real current line that already
       * carries a positive change. A single bar cannot represent both, so the
       * positive kind wins and removed is dropped (the dot gutter handles
       * removed in its own column). Pure removed anchors fall back to the
       * removed dash.
       */
      const modify: ChangeType | null = change.getModify();
      const kind: ChangeType | null = modify ?? (change.has(ChangeType.removed) ? ChangeType.removed : null);

      if (kind === null) {
        continue;
      }

      const line: Line = view.state.doc.line(pos + 1);

      builder.add(line.from, line.from, new BarMarker(kind));
    }

    return builder.finish();
  };

  /**
   * Whether the indicator type is `line`.
   *
   * @return {boolean} True in line mode
   */
  protected isTypeLine(): boolean {
    return this.settingsService.value('type') === IndicatorType.line;
  }
}
