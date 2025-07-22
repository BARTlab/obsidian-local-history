import { DEFAULT_SETTINGS, IndicatorType, KeepHistory } from '@/consts';
import { Inject } from '@/decorators/inject.decorator';
import { DomHelper } from '@/helpers/dom.helper';
import type LineChangeTrackerPlugin from '@/main';
import type { SettingsService } from '@/services/settings.service';
import {
  type DropdownComponent,
  PluginSettingTab,
  Setting,
  type SliderComponent,
  type TextComponent,
  type ToggleComponent
} from 'obsidian';

/**
 * Settings tab for the Line Change Tracker plugin.
 * Provides a user interface for configuring plugin settings.
 * Allows users to customize indicator types, history retention,
 * and appearance of change indicators.
 *
 * @extends PluginSettingTab
 */
export class MainSetting extends PluginSettingTab {
  /**
   * Service for accessing and updating plugin settings.
   * Injected using the @Inject decorator.
   */
  @Inject('SettingsService')
  protected settingsService: SettingsService;

  /**
   * The plugin instance.
   * Used to access plugin functionality.
   */
  protected plugin: LineChangeTrackerPlugin;

  /**
   * Renders the settings UI.
   * Creates and configures all settings elements in the settings tab.
   * Organizes settings into logical sections:
   * - Indicator type (line or dot in gutter)
   * - History retention options
   * - Toggle switches for different change types (changed, restored, added, removed)
   * - Line indicator width configuration
   * - Gutter indicator character customization
   *
   * Each setting is bound to the corresponding value in the plugin settings
   * and updates the settings when changed.
   */
  public display(): void {
    const { containerEl } = this;

    containerEl.empty();

    new Setting(containerEl)
      .setName('Type')
      .setDesc('Choose between a vertical line or a dot in the gutter.')
      .addDropdown((dropdown) =>
        dropdown
          .addOption(IndicatorType.line, 'Vertical Line')
          .addOption(IndicatorType.dot, 'Char in Gutter')
          .setValue(this.settingsService.value('type'))
          .onChange((value: IndicatorType): void => {
            this.settingsService.update('type', value);
          })
      );

    new Setting(containerEl)
      .setName('Allowed file extensions')
      .setDesc('Comma-separated list of file extensions to track for changes (e.g., md, txt, csv, json, yaml)')
      .addText((text: TextComponent): TextComponent =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.allowedExtensions)
          .setValue(this.settingsService.value('allowedExtensions'))
          .onChange((value: string): void => {
            this.settingsService.update(
              'allowedExtensions',
              value || DEFAULT_SETTINGS.allowedExtensions
            );
          })
      );

    new Setting(containerEl)
      .setName('Keep history until')
      .setDesc('Strategy for cleaning up revision history')
      .addDropdown((dropdown: DropdownComponent): DropdownComponent =>
        dropdown
          .addOption(KeepHistory.app, 'App close')
          .addOption(KeepHistory.file, 'File close')
          .setValue(this.settingsService.value('keep'))
          .onChange((value: KeepHistory): void => {
            this.settingsService.update('keep', value);
          })
      );

    new Setting(containerEl)
      .setName('Ignore new files')
      .setDesc('Don\'t track changes in files created after tracking started')
      .addToggle((toggle: ToggleComponent): ToggleComponent =>
        toggle
          .setValue(this.settingsService.value('ignoreNewFiles'))
          .onChange((value: boolean): void => {
            this.settingsService.update('ignoreNewFiles', value);
          })
      );

    // ----- changed -----

    new Setting(containerEl)
      .setName('Show indicator for')
      .setHeading();

    new Setting(containerEl)
      .setName('Changed')
      .addToggle((toggle: ToggleComponent): ToggleComponent =>
        toggle
          .setValue(this.settingsService.value('show.changed'))
          .onChange((value: boolean): void => {
            this.settingsService.update('show.changed', value);
          })
      );

    // ----- restored -----

    new Setting(containerEl)
      .setName('Restored')
      .addToggle((toggle: ToggleComponent): ToggleComponent =>
        toggle
          .setValue(this.settingsService.value('show.restored'))
          .onChange((value: boolean): void => {
            this.settingsService.update('show.restored', value);
          })
      );

    // ----- added -----

    new Setting(containerEl)
      .setName('Added')
      .addToggle((toggle: ToggleComponent): ToggleComponent =>
        toggle
          .setValue(this.settingsService.value('show.added'))
          .onChange((value: boolean): void => {
            this.settingsService.update('show.added', value);
          })
      );

    // ----- removed -----

    new Setting(containerEl)
      .setName('Removed')
      .addToggle((toggle: ToggleComponent): ToggleComponent =>
        toggle
          .setValue(this.settingsService.value('show.removed'))
          .onChange((value: boolean): void => {
            this.settingsService.update('show.removed', value);
          })
      );

    // ----- line -----

    new Setting(containerEl)
      .setName('Line indicator')
      .setHeading();

    new Setting(containerEl)
      .setName('Width')
      .setDesc('Width of the vertical line indicator (in pixels).')
      .addSlider((slider: SliderComponent): SliderComponent =>
        slider
          .setLimits(1, 5, 1)
          .setValue(this.settingsService.value('line.width'))
          .setDynamicTooltip()
          .onChange((value) => {
            this.settingsService.update('line.width', value);
          })
      );

    new Setting(containerEl)
      .setName('Gutter indicator')
      .setDesc(((): DocumentFragment => {
        return DomHelper.createFragment([
          {
            tag: 'div',
            children: [
              {
                tag: 'span',
                text: 'Chars of the gutter type indicator ('
              },
              {
                tag: 'a',
                text: 'https://symbl.cc/en/unicode-table/',
                attributes: {
                  href: 'https://symbl.cc/en/unicode-table/',
                  target: '_blank'
                }
              },
              {
                tag: 'span',
                text: ').'
              }
            ]
          }
        ]);
      })())
      .setHeading();

    new Setting(containerEl)
      .setName('Change char')
      .addText((text: TextComponent): TextComponent =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.gutter.changed)
          .setValue(this.settingsService.value('gutter.changed'))
          .onChange((value): void => {
            this.settingsService.update('gutter.changed', value || DEFAULT_SETTINGS.gutter.changed);
          })
      );

    new Setting(containerEl)
      .setName('Added char')
      .addText((text: TextComponent): TextComponent =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.gutter.added)
          .setValue(this.settingsService.value('gutter.added'))
          .onChange((value): void => {
            this.settingsService.update('gutter.added', value || DEFAULT_SETTINGS.gutter.added);
          })
      );

    new Setting(containerEl)
      .setName('Restore char')
      .addText((text: TextComponent): TextComponent =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.gutter.restored)
          .setValue(this.settingsService.value('gutter.restored'))
          .onChange((value): void => {
            this.settingsService.update('gutter.restored', value || DEFAULT_SETTINGS.gutter.restored);
          })
      );

    new Setting(containerEl)
      .setName('Removed char')
      .addText((text: TextComponent): TextComponent =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.gutter.removed)
          .setValue(this.settingsService.value('gutter.removed'))
          .onChange((value): void => {
            this.settingsService.update('gutter.removed', value || DEFAULT_SETTINGS.gutter.removed);
          })
      );
  }
}
