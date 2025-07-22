// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { ChangeType, PluginEvent, STYLE_ID } from '@/consts';
import { Inject } from '@/decorators/inject.decorator';
import { On as _On } from '@/decorators/on.decorator';
import type LineChangeTrackerPlugin from '@/main';
import type { SettingsService } from '@/services/settings.service';
import type { Service } from '@/types';

/**
 * Service responsible for managing CSS styles in the plugin.
 * Creates and updates style elements with CSS variables for line change indicators.
 * Responds to settings changes to update styling accordingly.
 *
 * @implements {Service}
 */
export class StylesService implements Service {
  /**
   * Service for accessing plugin settings.
   * Injected using the @Inject decorator.
   */
  @Inject('SettingsService')
  protected settingsService: SettingsService;

  /**
   * HTML style element that contains the CSS for line change indicators.
   * Created during initialization and updated when settings change.
   */
  protected sheet: HTMLStyleElement;

  /**
   * Creates a new instance of StylesService.
   *
   * @param {LineChangeTrackerPlugin} plugin - The plugin instance
   */
  public constructor(
    public plugin: LineChangeTrackerPlugin,
  ) {
  }

  /**
   * Initializes the service by creating a style tag.
   * Called during plugin initialization.
   */
  public init(): void {
    this.createStyleTag();
  }

  /**
   * Loads the service by updating the CSS styles.
   * Called after initialization to apply initial styles.
   */
  public load(): void {
    this.update();
  }

  /**
   * Updates the CSS styles based on current settings.
   * Sets CSS variables for colors and dimensions of line change indicators.
   * Automatically triggered when settings are updated via the @_On decorator.
   */
  @_On(PluginEvent.settingsUpdate)
  public update(): void {
    const width: number = this.settingsService.value('line.width');

    this.sheet.setText(`
        .lct {
          --lct-color-${ChangeType.changed}: var(--color-blue);
          --lct-color-${ChangeType.restored}: var(--text-faint);
          --lct-color-${ChangeType.added}: var(--color-orange);
          --lct-color-${ChangeType.removed}: var(--color-base-100);
          --lct-line-width: ${width}px;
          --lct-line-border-radius: ${(width / 2).toFixed(0)}px;
        }
    `);
  }

  /**
   * Unloads the service by removing the style element from the DOM.
   * Called when the plugin is disabled or unloaded.
   * Performs a safety check to ensure the sheet exists before attempting removal.
   */
  public unload(): void {
    if (!this.sheet) {
      return;
    }

    this.sheet.remove();
  }

  /**
   * Creates a style tag in the document head.
   * Either finds an existing style element with the plugin's style ID or creates a new one.
   * Sets appropriate attributes and appends it to the document head if needed.
   * Assigns the created/found element to the sheet property for later use.
   */
  protected createStyleTag(): void {
    const styleSheet: HTMLStyleElement =
      document.getElementById(STYLE_ID) as HTMLStyleElement || document.createElement('style');

    styleSheet.setAttribute('type', 'text/css');
    styleSheet.setAttribute('id', STYLE_ID);

    if (!styleSheet.parentElement) {
      document.head.appendChild(styleSheet);
    }

    this.sheet = styleSheet;
  }
}
