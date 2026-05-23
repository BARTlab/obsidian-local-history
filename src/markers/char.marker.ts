import { ChangeType, IndicatorType, REVERT_GLYPH } from '@/consts';
import { Inject } from '@/decorators/inject.decorator';
import type LineChangeTrackerPlugin from '@/main';
import type { SettingsService } from '@/services/settings.service';
import type { RevertLine } from '@/types';
import { GutterMarker } from '@codemirror/view';

/**
 * Marker class for displaying character indicators in the editor gutter.
 * Shows different characters for different types of changes (changed, added, restored).
 * Characters are configurable through plugin settings.
 *
 * @extends GutterMarker
 */
export class DotMarker extends GutterMarker {
  /**
   * Service for accessing plugin settings.
   * Injected using the @Inject decorator.
   */
  @Inject('SettingsService')
  protected settingsService!: SettingsService;

  /**
   * Map of change types to their corresponding gutter characters.
   * Characters are retrieved from plugin settings.
   */
  protected char: { [key: string]: string };

  /**
   * CSS class applied to the gutter marker element.
   * Combines the dot indicator type with the specific change type.
   */
  public elementClass: string;

  /**
   * Creates a new instance of DotMarker.
   *
   * @param {ChangeType} changes - The type of change this marker represents
   * @param {LineChangeTrackerPlugin} plugin - The plugin instance
   * @param {number} line - The 0-based current line this marker sits on (-1 when unknown)
   * @param {RevertLine | null} revert - Callback to revert the block at this line, or null for no affordance
   */
  public constructor(
    protected changes: ChangeType,
    protected plugin: LineChangeTrackerPlugin,
    protected line: number = -1,
    protected revert: RevertLine | null = null,
  ) {
    super();

    /**
     * Resolve settings-derived state in the constructor body, after the
     * parameter properties are assigned. As field initializers this would read
     * the injected settingsService (which needs this.plugin) and this.changes
     * before they exist under useDefineForClassFields, breaking injection.
     */
    this.char = {
      [ChangeType.changed]: this.settingsService.value('gutter.changed'),
      [ChangeType.added]: this.settingsService.value('gutter.added'),
      [ChangeType.restored]: this.settingsService.value('gutter.restored'),
    };
    this.elementClass = `lct-${IndicatorType.dot} lct-${this.changes}`;
  }

  /**
   * Creates a DOM node for the gutter marker.
   * Renders the change-type character and, when a revert callback is set, a
   * clickable revert affordance for the block at this line. The affordance is an
   * accessible button (text label via aria-label and title) whose click reverts
   * only this block and is stopped from reaching the editor so the caret does
   * not jump. The click listener lives on this node, which CodeMirror discards
   * together with the marker when the gutter is rebuilt or the view is
   * destroyed, so no listener is leaked.
   *
   * @return {Node} A DOM node with the change character and optional revert affordance
   * @override
   */
  public toDOM(): Node {
    const wrapper: HTMLSpanElement = document.createElement('span');

    wrapper.addClass('lct-gutter-marker');
    wrapper.createSpan({ cls: 'lct-gutter-char', text: this.char[this.changes] });

    if (!this.revert) {
      return wrapper;
    }

    const button: HTMLButtonElement = wrapper.createEl('button', {
      cls: 'lct-gutter-revert',
      text: REVERT_GLYPH,
      attr: { 'aria-label': 'Revert this change', 'title': 'Revert this change', 'type': 'button' },
    });

    button.addEventListener('click', (event: MouseEvent): void => {
      /**
       * Stop the gutter click from moving the caret or selecting the line.
       */
      event.preventDefault();
      event.stopPropagation();

      this.revert?.(this.line);
    });

    return wrapper;
  }

  /**
   * Checks if this marker is equal to another marker.
   * Markers are equal when they share the change type, the character, the line
   * they sit on, and whether they carry a revert affordance. The line is part of
   * the identity so CodeMirror rebuilds the DOM node (and its line-bound revert
   * handler) when a marker shifts to another line, keeping the affordance wired
   * to the correct block.
   *
   * @param {DotMarker} other - The marker to compare with
   * @return {boolean} True if the markers are equal, false otherwise
   * @override
   */
  public eq(other: DotMarker): boolean {
    if (!(other instanceof DotMarker)) {
      return false;
    }

    return this.getChangeType() === other.getChangeType()
      && this.getChar() === other.getChar()
      && this.line === other.line
      && (this.revert === null) === (other.revert === null);
  }

  /**
   * Gets the change type of this marker.
   *
   * @return {ChangeType} The change type (changed, added, restored)
   */
  public getChangeType(): ChangeType {
    return this.changes;
  }

  /**
   * Gets the character used for this marker.
   *
   * @return {string} The character from settings for this marker's change type
   */
  public getChar(): string {
    return this.char[this.changes];
  }
}
