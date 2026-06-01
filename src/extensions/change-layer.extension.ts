import { ChangeType, IndicatorType } from '@/consts';
import { Inject } from '@/decorators/inject.decorator';
import { refreshDecorationsEffect } from '@/extensions/refresh.effect';
import type { ChangeLine } from '@/lines/change.line';
import type { ArrayMap } from '@/maps/array.map';
import type LineChangeTrackerPlugin from '@/main';
import type { SettingsService } from '@/services/settings.service';
import type { SnapshotsService } from '@/services/snapshots.service';
import type { FileSnapshot } from '@/snapshots/file.snapshot';
import type { Extension, Line } from '@codemirror/state';
import type { BlockInfo, EditorView, LayerMarker, ViewUpdate } from '@codemirror/view';
import { layer, RectangleMarker } from '@codemirror/view';

/**
 * Pixels to push the change bar left of the editor content edge, so it lands in
 * the gutter-side gap rather than overlapping the text. Roughly mirrors the
 * `left: -10px` offset the `.cm-line` based bar uses in the stylesheet.
 */
const BAR_LEFT_OFFSET: number = 10;

/**
 * A collapsed block and the changed source lines that fall inside it, keyed by
 * their 0-based offset from the block's first line so a table can be matched to
 * its rendered rows.
 */
interface BlockGroup {
  block: BlockInfo;
  rows: Map<number, Set<ChangeType>>;
}

/**
 * Draws the `line` change indicator as a margin layer keyed to block geometry
 * instead of to `.cm-line` elements. In Live Preview a rendered block (a table,
 * a callout, an embed) replaces its source lines with a single block widget, so
 * the per-line `Decoration.line` bar from {@link EditorCommonExtension} has no
 * `.cm-line` to attach to and stays hidden until the cursor reveals a row. This
 * layer covers exactly that gap: for every changed line that sits inside the
 * viewport but is hidden by a replace decoration, it paints one bar over the
 * rendered block it collapsed into. Visible source lines are left to the
 * decoration path, so the two never double up.
 */
export class ChangeLayerExtension {
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
   * Creates a new instance of ChangeLayerExtension.
   *
   * @param {LineChangeTrackerPlugin} plugin - The plugin instance, read by the
   *   @Inject decorator to resolve services.
   */
  public constructor(
    protected plugin: LineChangeTrackerPlugin,
  ) {
  }

  /**
   * Builds the CodeMirror layer extension. The layer renders below the text so
   * the bars sit behind the content, and re-measures whenever the document, the
   * viewport, the geometry, or the snapshot/settings (via the refresh effect)
   * change.
   *
   * @return {Extension} The configured layer extension
   */
  public build(): Extension {
    return layer({
      above: false,
      class: 'lct-change-layer',
      update: (update: ViewUpdate): boolean => this.needsUpdate(update),
      markers: (view: EditorView): readonly LayerMarker[] => this.markers(view),
    });
  }

  /**
   * Decides whether the layer must re-measure its markers for this update.
   *
   * @param {ViewUpdate} update - The view update event from CodeMirror
   * @return {boolean} True if the markers need to be rebuilt
   */
  protected needsUpdate(update: ViewUpdate): boolean {
    return update.docChanged
      || update.viewportChanged
      || update.geometryChanged
      || update.transactions.some((transaction): boolean =>
        transaction.effects.some((effect): boolean => effect.is(refreshDecorationsEffect)));
  }

  /**
   * Computes the markers for the current view, gated on the `line` indicator
   * type and the presence of a snapshot with changes.
   *
   * @param {EditorView} view - The editor view to build markers for
   * @return {LayerMarker[]} The markers to draw, possibly empty
   */
  protected markers(view: EditorView): LayerMarker[] {
    if (!this.plugin.isReady()) {
      return [];
    }

    const snapshot: FileSnapshot | null = this.snapshotsService.getOne();
    const changes: ArrayMap<ChangeLine> | null = snapshot?.getChanges(this.getEnableTypes()) ?? null;

    if (!this.isTypeLine() || !snapshot || !changes?.size) {
      return [];
    }

    return this.buildMarkers(view, changes);
  }

  /**
   * Builds the bars for every rendered block that hosts a hidden changed line.
   * Changed lines are grouped by the block they collapse into; per block, each
   * changed source line keeps its own change types so a table can be lit row by
   * row. A table is mapped to its rendered `<tr>` rects so only the changed rows
   * are marked; any other widget (callout, embed) falls back to one bar over the
   * whole block, since it has no per-line geometry.
   *
   * @param {EditorView} view - The editor view to measure against
   * @param {ArrayMap<ChangeLine>} changes - The changed lines, keyed by 0-based index
   * @return {RectangleMarker[]} The bars to draw
   */
  protected buildMarkers(view: EditorView, changes: ArrayMap<ChangeLine>): RectangleMarker[] {
    const blocks: Map<number, BlockGroup> = new Map();
    const order: number[] = [];
    const lines: number = view.state.doc.lines;

    for (const [key, change] of changes) {
      const lineNumber: number = Number(key) + 1;

      if (lineNumber < 1 || lineNumber > lines) {
        continue;
      }

      const line: Line = view.state.doc.line(lineNumber);

      if (!this.isHidden(view, line.from)) {
        continue;
      }

      const block: BlockInfo = view.lineBlockAt(line.from);
      let group: BlockGroup = blocks.get(block.from);

      if (!group) {
        group = { block, rows: new Map<number, Set<ChangeType>>() };
        blocks.set(block.from, group);
        order.push(block.from);
      }

      const startLine: number = view.state.doc.lineAt(block.from).number;
      const offset: number = lineNumber - startLine;
      let types: Set<ChangeType> = group.rows.get(offset);

      if (!types) {
        types = new Set<ChangeType>();
        group.rows.set(offset, types);
      }

      change.getTypes().forEach((type: ChangeType): void => {
        types.add(type);
      });
    }

    const left: number = this.getLeftBase(view) - BAR_LEFT_OFFSET;
    const markers: RectangleMarker[] = [];

    for (const from of order) {
      this.markersForBlock(view, blocks.get(from), left, markers);
    }

    return markers;
  }

  /**
   * Appends the bars for a single block to the accumulator: per-row bars when
   * the block is a table whose rendered rows could be matched to its source
   * lines, otherwise one bar spanning the whole block.
   *
   * @param {EditorView} view - The editor view to measure against
   * @param {BlockGroup} group - The block and its changed rows
   * @param {number} left - The shared left coordinate for every bar
   * @param {RectangleMarker[]} markers - The accumulator to push bars onto
   * @return {void}
   */
  protected markersForBlock(
    view: EditorView,
    group: BlockGroup,
    left: number,
    markers: RectangleMarker[],
  ): void {
    const rowRects: DOMRect[] | null = this.tableRowRects(view, group.block);

    if (rowRects) {
      const contentTop: number = view.contentDOM.getBoundingClientRect().top;
      const padding: number = view.documentPadding.top;

      for (const [offset, types] of group.rows) {
        const index: number = this.rowIndexForOffset(offset);
        const rect: DOMRect | undefined = index >= 0 ? rowRects[index] : undefined;

        if (rect) {
          const top: number = rect.top - contentTop + padding;

          markers.push(new RectangleMarker(this.classNamesFor(types), left, top, null, rect.height));
        }
      }

      return;
    }

    const types: Set<ChangeType> = new Set<ChangeType>();

    group.rows.forEach((set: Set<ChangeType>): void => {
      set.forEach((type: ChangeType): void => {
        types.add(type);
      });
    });

    markers.push(new RectangleMarker(
      this.classNamesFor(types),
      left,
      view.documentPadding.top + group.block.top,
      null,
      group.block.height,
    ));
  }

  /**
   * Maps a source-line offset within a markdown table to the index of its
   * rendered `<tr>`. Row 0 is the header; offset 1 is the `|---|` delimiter,
   * which renders no row; every later data row shifts down by the delimiter.
   *
   * @param {number} offset - The 0-based source-line offset within the block
   * @return {number} The matching `<tr>` index, or -1 for the delimiter line
   */
  protected rowIndexForOffset(offset: number): number {
    if (offset === 0) {
      return 0;
    }

    return offset >= 2 ? offset - 1 : -1;
  }

  /**
   * Returns the bounding rects of a rendered table's rows when the block is a
   * table whose `<tr>` count matches its source lines minus the delimiter row,
   * so the offset-to-row mapping is trustworthy. Returns null for any other
   * widget or on a layout mismatch, signalling a whole-block fallback.
   *
   * @param {EditorView} view - The editor view holding the rendered widget
   * @param {BlockInfo} block - The collapsed block to resolve
   * @return {DOMRect[] | null} The row rects, or null when row mapping is unsafe
   */
  protected tableRowRects(view: EditorView, block: BlockInfo): DOMRect[] | null {
    const table: HTMLTableElement | null = this.findBlockTable(view, block);

    if (!table) {
      return null;
    }

    const rows: HTMLTableRowElement[] = Array.from(table.rows);
    const sourceLines: number = view.state.doc.lineAt(block.to).number - view.state.doc.lineAt(block.from).number + 1;

    if (!rows.length || rows.length !== sourceLines - 1) {
      return null;
    }

    return rows.map((row: HTMLTableRowElement): DOMRect => row.getBoundingClientRect());
  }

  /**
   * Finds the rendered `<table>` whose Live Preview widget maps to the given
   * block, by matching each table widget's document position against the block
   * range.
   *
   * @param {EditorView} view - The editor view to search within
   * @param {BlockInfo} block - The collapsed block to resolve
   * @return {HTMLTableElement | null} The matching table element, or null
   */
  protected findBlockTable(view: EditorView, block: BlockInfo): HTMLTableElement | null {
    const widgets: NodeListOf<HTMLElement> = view.contentDOM.querySelectorAll('.cm-table-widget');

    for (const widget of Array.from(widgets)) {
      let pos: number;

      try {
        pos = view.posAtDOM(widget);
      } catch {
        continue;
      }

      if (pos >= block.from && pos <= block.to) {
        return widget.querySelector('table');
      }
    }

    return null;
  }

  /**
   * Resolves the content-space x of the editor content's left edge, the anchor
   * the bar offset is taken from.
   *
   * @param {EditorView} view - The editor view to measure
   * @return {number} The left edge in layer coordinates
   */
  protected getLeftBase(view: EditorView): number {
    const scrollRect: DOMRect = view.scrollDOM.getBoundingClientRect();
    const contentRect: DOMRect = view.contentDOM.getBoundingClientRect();

    return contentRect.left - scrollRect.left + view.scrollDOM.scrollLeft;
  }

  /**
   * Joins the per-type CSS classes for a bar. The `removed` type carries no bar
   * color in the layer, so it is dropped here.
   *
   * @param {Set<ChangeType>} types - The change types collapsed into this block
   * @return {string} The space-joined class string for the marker element
   */
  protected classNamesFor(types: Set<ChangeType>): string {
    const classNames: string[] = ['lct', `lct-${IndicatorType.line}`, 'lct-change-bar'];

    types.forEach((type: ChangeType): void => {
      if (type !== ChangeType.removed) {
        classNames.push(`lct-${type}`);
      }
    });

    return classNames.join(' ');
  }

  /**
   * Tests whether a position is inside the rendered viewport yet hidden by a
   * replace decoration (a Live Preview block widget). Positions outside the
   * viewport are off-screen and skipped; positions inside a visible range are
   * real source lines handled by the decoration path.
   *
   * @param {EditorView} view - The editor view to test against
   * @param {number} pos - The document position to classify
   * @return {boolean} True if the position is collapsed under a block widget
   */
  protected isHidden(view: EditorView, pos: number): boolean {
    if (pos < view.viewport.from || pos > view.viewport.to) {
      return false;
    }

    return !view.visibleRanges.some(({ from, to }): boolean => pos >= from && pos <= to);
  }

  /**
   * Checks if the indicator type is set to 'line'.
   *
   * @return {boolean} True if the indicator type is 'line', false otherwise
   */
  protected isTypeLine(): boolean {
    return this.settingsService.value('type') === IndicatorType.line;
  }

  /**
   * Gets the enabled change types that draw a bar. Mirrors the editor extension
   * minus the removed type, which has no bar representation in this layer.
   *
   * @return {ChangeType[]} Array of enabled change types
   */
  protected getEnableTypes(): ChangeType[] {
    return [
      ...this.settingsService.value('show.changed') ? [ChangeType.changed, ChangeType.whitespace] : [],
      ...this.settingsService.value('show.restored') ? [ChangeType.restored] : [],
      ...this.settingsService.value('show.added') ? [ChangeType.added] : [],
    ];
  }
}
