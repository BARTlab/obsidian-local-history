import { IndicatorType } from '@/consts';
import type { ChangeType } from '@/consts';
import { GutterMarker } from '@codemirror/view';

/**
 * Marker for the `line` change indicator, hosted in its own gutter column
 * instead of on the `.cm-line` margin. Each marker fills its gutter element so
 * adjacent changed lines stack into one continuous vertical stroke, and the bar
 * never shares a pseudo-element with the theme's blockquote marker (which lives
 * on `.cm-line::before`).
 *
 * The `removed` kind renders as a short dash pinned to the top of its anchor
 * line rather than a full-height bar; every other kind renders a full bar. The
 * visual difference is carried entirely by CSS keyed on the kind class, so this
 * marker only tags the element.
 *
 * @extends GutterMarker
 */
export class BarMarker extends GutterMarker {
  /**
   * CSS class applied to the gutter element wrapping the bar. Combines the line
   * indicator type with the specific change kind.
   */
  public elementClass: string;

  /**
   * Creates a new BarMarker.
   *
   * The join flags mark run continuation: a bar whose neighbouring line also
   * carries a full bar. CSS uses them to stretch the bar over the sub-pixel
   * seam between gutter elements and to drop the rounding on the shared edge,
   * so consecutive changed lines read as one continuous stroke.
   *
   * @param {ChangeType} changes - The change kind this bar represents
   * @param {boolean} joinUp - Whether the line above also carries a full bar
   * @param {boolean} joinDown - Whether the line below also carries a full bar
   */
  public constructor(
    protected changes: ChangeType,
    protected joinUp: boolean = false,
    protected joinDown: boolean = false,
  ) {
    super();

    this.elementClass = [
      `lct-${IndicatorType.line}`,
      `lct-${this.changes}`,
      ...(joinUp ? ['lct-join-up'] : []),
      ...(joinDown ? ['lct-join-down'] : []),
    ].join(' ');
  }

  /**
   * Renders the bar element. The bar fills the gutter element height; the
   * removed dash height is overridden in CSS.
   *
   * @return {Node} The bar DOM node
   * @override
   */
  public toDOM(): Node {
    const bar: HTMLSpanElement = activeDocument.createElement('span');

    bar.addClass('lct-gutter-bar');

    return bar;
  }

  /**
   * Two bar markers are equal when they share the change kind and both join
   * flags (a run-boundary change must re-render the element classes).
   *
   * @param {BarMarker} other - The marker to compare with
   * @return {boolean} True when equal
   * @override
   */
  public eq(other: BarMarker): boolean {
    return other instanceof BarMarker &&
      this.changes === other.changes &&
      this.joinUp === other.joinUp &&
      this.joinDown === other.joinDown;
  }

  /**
   * Gets the change kind of this marker.
   *
   * @return {ChangeType} The change kind
   */
  public getChangeType(): ChangeType {
    return this.changes;
  }
}
