import { ChangeType, IndicatorType } from '@/consts';
import { Inject } from '@/decorators/inject.decorator';
import type LineChangeTrackerPlugin from '@/main';
import type { SettingsService } from '@/services/settings.service';
import { GutterMarker } from '@codemirror/view';

/**
 * Marker class for displaying character indicators in the editor gutter.
 * Shows different characters for different types of changes (added, modified, restored).
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
  protected char: { [key: string]: string } = {
    [ChangeType.changed]: this.settingsService.value('gutter.changed'),
    [ChangeType.added]: this.settingsService.value('gutter.added'),
    [ChangeType.restored]: this.settingsService.value('gutter.restored'),
  };
  // protected char: string = this.settingsService.value('gutterChar');

  /**
   * CSS class applied to the gutter marker element.
   * Combines the dot indicator type with the specific change type.
   */
  public elementClass = `lct-${IndicatorType.dot} lct-${this.changes}`;

  /**
   * Creates a new instance of DotMarker.
   *
   * @param {ChangeType} changes - The type of change this marker represents
   * @param {LineChangeTrackerPlugin} plugin - The plugin instance
   */
  public constructor(
    protected changes: ChangeType,
    protected plugin: LineChangeTrackerPlugin,
  ) {
    super();
  }

  /**
   * Creates a DOM node for the gutter marker.
   * Returns a text node containing the character for this marker's change type.
   *
   * @return {Node} A DOM text node with the appropriate character
   * @override
   */
  public toDOM(): Node {
    return document.createTextNode(this.char[this.changes]);
  }

  /**
   * Checks if this marker is equal to another marker.
   * Markers are considered equal if they have the same change type and character.
   *
   * @param {DotMarker} other - The marker to compare with
   * @return {boolean} True if the markers are equal, false otherwise
   * @override
   */
  public eq(other: DotMarker): boolean {
    if (!(other instanceof DotMarker)) {
      return false;
    }

    return this.getChangeType() === other.getChangeType() && this.getChar() === other.getChar();
  }

  /**
   * Gets the change type of this marker.
   *
   * @return {ChangeType} The change type (added, modified, restored)
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
