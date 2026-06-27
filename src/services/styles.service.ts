import { PluginEvent } from '@/consts';
import { Inject } from '@/decorators/inject.decorator';
import { On as _On } from '@/decorators/on.decorator';
import type LineChangeTrackerPlugin from '@/main';
import type { SettingsService } from '@/services/settings.service';
import { TOKENS } from '@/services/tokens';
import type { Service } from '@/types';

const LINE_WIDTH_VAR: string = '--lct-line-width';
const LINE_BORDER_RADIUS_VAR: string = '--lct-line-border-radius';

/**
 * Keeps the settings-driven line-marker geometry in sync with the styles.
 *
 * The static change-status palette lives in styles.scss (loaded with the
 * plugin), so this service only writes the two settings-dependent custom
 * properties (bar width and corner radius). They are set on `document.body` so
 * they cascade to both the editor gutter bars and the reading-mode indicators.
 * No `<style>` element is injected (Obsidian guidelines discourage it).
 *
 * @implements {Service}
 */
export class StylesService implements Service {
  /** Service for accessing plugin settings. */
  @Inject(TOKENS.settings)
  protected settingsService!: SettingsService;

  public constructor(
    public plugin: LineChangeTrackerPlugin,
  ) {
  }

  /** Applies the initial marker geometry from current settings. */
  public load(): void {
    this.update();
  }

  /**
   * Writes the settings-driven marker geometry as CSS custom properties on the
   * document body. Triggered on settings changes via the @_On decorator.
   */
  @_On(PluginEvent.settingsUpdate)
  public update(): void {
    const width: number = this.settingsService.value('line.width');

    document.body.style.setProperty(LINE_WIDTH_VAR, `${width}px`);
    document.body.style.setProperty(LINE_BORDER_RADIUS_VAR, `${(width / 2).toFixed(0)}px`);
  }

  /** Clears the custom properties this service set on the document body. */
  public unload(): void {
    document.body.style.removeProperty(LINE_WIDTH_VAR);
    document.body.style.removeProperty(LINE_BORDER_RADIUS_VAR);
  }
}
