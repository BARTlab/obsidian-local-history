import { ChangeType, IndicatorType } from '@/consts';
import { Inject } from '@/decorators/inject.decorator';
import type LineChangeTrackerPlugin from '@/main';
import type { SettingsService } from '@/services/settings.service';
import { GutterMarker } from '@codemirror/view';

/**
 * Marker class for displaying indicators for removed lines in the editor gutter.
 * Shows a special character at positions where lines have been removed.
 * The character is configurable through plugin settings.
 *
 * @extends GutterMarker
 */
export class RemovedMarker extends GutterMarker {
  /**
   * Service for accessing plugin settings.
   * Injected using the @Inject decorator.
   */
  @Inject('SettingsService')
  protected settingsService: SettingsService;

  /**
   * CSS class applied to the gutter marker element.
   * Combines the dot indicator type with the removed change type.
   */
  public elementClass: string = `lct-${IndicatorType.dot} lct-${ChangeType.removed}`;

  /**
   * Creates a new instance of RemovedMarker.
   *
   * @param {LineChangeTrackerPlugin} plugin - The plugin instance
   */
  public constructor(
    protected plugin: LineChangeTrackerPlugin,
  ) {
    super();
  }

  /**
   * Creates a DOM node for the gutter marker.
   * Returns a text node containing the character for removed lines from settings.
   *
   * @return {Node} A DOM text node with the appropriate character
   * @override
   */
  public toDOM(): Node {
    return document.createTextNode(this.settingsService.value('gutter.removed'));
  }
}
