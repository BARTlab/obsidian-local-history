import { ChangeType, IndicatorType } from '@/consts';
import { Inject } from '@/decorators/inject.decorator';
import type LineChangeTrackerPlugin from '@/main';
import type { I18nService } from '@/services/i18n.service';
import type { SettingsService } from '@/services/settings.service';
import { TOKENS } from '@/services/tokens';
import type { RevertLine } from '@/types';
import { GutterMarker } from '@codemirror/view';

/**
 * Marker class for displaying indicators for removed lines in the editor gutter.
 * Shows a special character at positions where lines have been removed.
 * The character is configurable through plugin settings.
 *
 * When a revert callback is provided the marker renders as an accessible button
 * so the user can restore the deleted line directly from the gutter without
 * opening the history modal.
 *
 * @extends GutterMarker
 */
export class RemovedMarker extends GutterMarker {
  @Inject(TOKENS.settings)
  protected settingsService!: SettingsService;

  @Inject(TOKENS.i18n)
  protected i18nService!: I18nService;

  /**
   * CSS class applied to the gutter marker element.
   * Combines the dot indicator type with the removed change type.
   */
  public elementClass: string = `lct-${IndicatorType.dot} lct-${ChangeType.removed}`;

  /**
   * Creates a new instance of RemovedMarker.
   *
   * @param {LineChangeTrackerPlugin} plugin - The plugin instance
   * @param {number} line - The 0-based current line this marker sits on (-1 when unknown)
   * @param {RevertLine | null} revert - Callback to revert the removed line, or null for no affordance
   */
  public constructor(
    public plugin: LineChangeTrackerPlugin,
    protected line: number = -1,
    protected revert: RevertLine | null = null,
  ) {
    super();
  }

  /**
   * Creates a DOM node for the gutter marker.
   * When a revert callback is set, renders an accessible button (role="button",
   * aria-label) that restores the deleted line on click without opening the
   * history modal. When no callback is set, returns a plain text node.
   *
   * @return {Node} A DOM node with the marker character and optional revert affordance
   * @override
   */
  public toDOM(): Node {
    const char: string = this.settingsService.value('gutter.removed');

    if (!this.revert) {
      return document.createTextNode(char);
    }

    const label: string = this.i18nService.t('gutter.revert');
    const button: HTMLButtonElement = document.createElement('button');

    button.setAttribute('role', 'button');
    button.setAttribute('aria-label', label);
    button.setAttribute('type', 'button');
    button.className = 'lct-gutter-revert';
    button.textContent = char;

    button.addEventListener('click', (event: MouseEvent): void => {
      event.preventDefault();
      event.stopPropagation();
      this.revert?.(this.line);
    });

    return button;
  }

  /**
   * Checks if this marker is equal to another marker.
   * Markers are equal when they share the same line and revert affordance
   * presence. CodeMirror rebuilds the DOM node when they differ.
   *
   * @param {RemovedMarker} other - The marker to compare with
   * @return {boolean} True if the markers are equal, false otherwise
   * @override
   */
  public eq(other: RemovedMarker): boolean {
    if (!(other instanceof RemovedMarker)) {
      return false;
    }

    return this.line === other.line && (this.revert === null) === (other.revert === null);
  }
}
