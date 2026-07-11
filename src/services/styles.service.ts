import { LINE_BORDER_RADIUS_VAR, LINE_WIDTH_VAR, PluginEvent, TINT_STRENGTH_VAR } from '@/consts';
import { Inject } from '@/decorators/inject.decorator';
import { On as _On } from '@/decorators/on.decorator';
import type LineChangeTrackerPlugin from '@/main';
import type { SettingsService } from '@/services/settings.service';
import { TOKENS } from '@/services/tokens';
import type { Service } from '@/types';

/**
 * Keeps the settings-driven line-marker geometry in sync with the styles.
 *
 * The static change-status palette lives in styles.scss (loaded with the
 * plugin), so this service only writes the settings-dependent custom
 * properties: the bar width, the corner radius, and the marker intensity. They
 * are set on `document.body` so they cascade to both the editor gutter bars and
 * the reading-mode indicators (and, for the intensity, the file-tree and tab
 * tints too). No `<style>` element is injected (Obsidian guidelines discourage
 * it). The intensity is written as a percentage into `--lct-tint-strength`,
 * which styles.scss also declares a static fallback for, so the inline value
 * wins once this runs (a snippet must use `!important` to override it).
 *
 * It also toggles the `lct-hover-affordance` body class from the
 * gutter-hover-panel setting, which styles.scss keys the gutter marker's hover
 * widening and extended hit zone on, so one switch gates the whole affordance.
 *
 * @implements {Service}
 */
export class StylesService implements Service {
  /** Body class gating the gutter marker hover affordance (styles.scss keys on it). */
  protected static readonly HOVER_AFFORDANCE_CLASS = 'lct-hover-affordance';

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
   * document body and toggles the hover-affordance class from the
   * gutter-hover-panel setting. Triggered on settings changes via the @_On
   * decorator, so the toggle applies live without an editor rebuild.
   */
  @_On(PluginEvent.settingsUpdate)
  public update(): void {
    const width: number = this.settingsService.value('line.width');
    const intensity: number = this.settingsService.value('markerIntensity');

    activeDocument.body.style.setProperty(LINE_WIDTH_VAR, `${width}px`);
    activeDocument.body.style.setProperty(LINE_BORDER_RADIUS_VAR, `${(width / 2).toFixed(0)}px`);
    activeDocument.body.style.setProperty(TINT_STRENGTH_VAR, `${intensity}%`);
    activeDocument.body.classList.toggle(
      StylesService.HOVER_AFFORDANCE_CLASS,
      this.settingsService.value('gutterHoverPanel'),
    );
  }

  /** Clears the custom properties and hover-affordance class this service set. */
  public unload(): void {
    activeDocument.body.style.removeProperty(LINE_WIDTH_VAR);
    activeDocument.body.style.removeProperty(LINE_BORDER_RADIUS_VAR);
    activeDocument.body.style.removeProperty(TINT_STRENGTH_VAR);
    activeDocument.body.classList.remove(StylesService.HOVER_AFFORDANCE_CLASS);
  }
}
