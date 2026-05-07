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
  type TextAreaComponent,
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
          .addOption(IndicatorType.line, 'Vertical line')
          .addOption(IndicatorType.dot, 'Char in gutter')
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
      .setName('Excluded paths')
      .setDesc(
        'Paths or glob patterns to never track, one per line or comma-separated '
        + '(e.g. Templates, Daily/**, *.excalidraw.md). Matched against the '
        + 'vault-relative path.'
      )
      .addTextArea((text: TextAreaComponent): TextAreaComponent =>
        text
          .setPlaceholder('Templates\nDaily/**')
          .setValue(this.settingsService.value('excludePaths'))
          .onChange((value: string): void => {
            this.settingsService.update('excludePaths', value);
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

    new Setting(containerEl)
      .setName('Persist history across restarts')
      .setDesc('Save history to disk so highlights survive a restart. Requires "keep history until" set to app close.')
      .addToggle((toggle: ToggleComponent): ToggleComponent =>
        toggle
          .setValue(this.settingsService.value('persist'))
          .onChange((value: boolean): void => {
            this.settingsService.update('persist', value);
          })
      );

    new Setting(containerEl)
      .setName('Max stored files')
      .setDesc('Cap on how many file histories are kept on disk. Oldest are evicted first. Set to 0 to disable.')
      .addText((text: TextComponent): TextComponent =>
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.retention.maxEntries))
          .setValue(String(this.settingsService.value('retention.maxEntries')))
          .onChange((value: string): void => {
            const count: number = this.toCount(value, DEFAULT_SETTINGS.retention.maxEntries);

            this.settingsService.update('retention.maxEntries', count);
          })
      );

    new Setting(containerEl)
      .setName('Max history age (days)')
      .setDesc('Drop persisted history older than this many days. Set to 0 to disable.')
      .addText((text: TextComponent): TextComponent =>
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.retention.maxAgeDays))
          .setValue(String(this.settingsService.value('retention.maxAgeDays')))
          .onChange((value: string): void => {
            const days: number = this.toCount(value, DEFAULT_SETTINGS.retention.maxAgeDays);

            this.settingsService.update('retention.maxAgeDays', days);
          })
      );

    // ----- intermediate snapshots (timeline) -----

    new Setting(containerEl)
      .setName('Timeline snapshots')
      .setHeading();

    new Setting(containerEl)
      .setName('Capture intermediate versions')
      .setDesc('Keep a timeline of earlier versions so you can diff against a point in between, not just the original.')
      .addToggle((toggle: ToggleComponent): ToggleComponent =>
        toggle
          .setValue(this.settingsService.value('snapshots.enabled'))
          .onChange((value: boolean): void => {
            this.settingsService.update('snapshots.enabled', value);
          })
      );

    new Setting(containerEl)
      .setName('Capture every (edits)')
      .setDesc('Take a version after this many edits. Set to 0 to disable the edit trigger.')
      .addText((text: TextComponent): TextComponent =>
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.snapshots.editThreshold))
          .setValue(String(this.settingsService.value('snapshots.editThreshold')))
          .onChange((value: string): void => {
            this.settingsService.update(
              'snapshots.editThreshold',
              this.toCount(value, DEFAULT_SETTINGS.snapshots.editThreshold)
            );
          })
      );

    new Setting(containerEl)
      .setName('Capture every (minutes)')
      .setDesc('Take a version after this many minutes of editing. Set to 0 to disable the time trigger.')
      .addText((text: TextComponent): TextComponent =>
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.snapshots.intervalMs / 60000))
          .setValue(String(this.settingsService.value('snapshots.intervalMs') / 60000))
          .onChange((value: string): void => {
            const minutes: number = this.toCount(value, DEFAULT_SETTINGS.snapshots.intervalMs / 60000);

            this.settingsService.update('snapshots.intervalMs', minutes * 60000);
          })
      );

    new Setting(containerEl)
      .setName('Max versions per file')
      .setDesc('Cap on intermediate versions kept per file. Oldest are evicted first. Set to 0 to disable.')
      .addText((text: TextComponent): TextComponent =>
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.snapshots.maxVersions))
          .setValue(String(this.settingsService.value('snapshots.maxVersions')))
          .onChange((value: string): void => {
            this.settingsService.update(
              'snapshots.maxVersions',
              this.toCount(value, DEFAULT_SETTINGS.snapshots.maxVersions)
            );
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

  /**
   * Parses a user-entered retention count into a non-negative integer.
   * Falls back to the provided default when the input is empty or not a valid
   * number, and clamps negatives to zero (zero disables the cap).
   *
   * @param {string} value - The raw text input
   * @param {number} fallback - The value to use when input is invalid
   * @return {number} A non-negative integer count
   */
  protected toCount(value: string, fallback: number): number {
    const parsed: number = Number.parseInt(value, 10);

    if (Number.isNaN(parsed)) {
      return fallback;
    }

    return Math.max(0, parsed);
  }
}
