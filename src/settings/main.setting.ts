import { DEFAULT_SETTINGS, IndicatorType, KeepHistory } from '@/consts';
import { Inject } from '@/decorators/inject.decorator';
import { DomHelper } from '@/helpers/dom.helper';
import { PathExcludeHelper } from '@/helpers/path-exclude.helper';
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
  //noinspection JSDeprecatedSymbols
  public display(): void {
    const { containerEl } = this;

    containerEl.empty();

    new Setting(containerEl)
      .setName(this.plugin.t('setting.type.name'))
      .setDesc(this.plugin.t('setting.type.desc'))
      .addDropdown((dropdown) =>
        dropdown
          .addOption(IndicatorType.line, this.plugin.t('setting.type.option.line'))
          .addOption(IndicatorType.dot, this.plugin.t('setting.type.option.dot'))
          .setValue(this.settingsService.value('type'))
          .onChange((value: IndicatorType): void => {
            this.settingsService.update('type', value);
          })
      );

    new Setting(containerEl)
      .setName(this.plugin.t('setting.allowed-extensions.name'))
      .setDesc(this.plugin.t('setting.allowed-extensions.desc'))
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
      .setName(this.plugin.t('setting.exclude-paths.name'))
      .setDesc(this.plugin.t('setting.exclude-paths.desc'))
      .addText((text: TextComponent): TextComponent =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.excludePaths)
          .setValue(this.settingsService.value('excludePaths'))
          .onChange((value: string): void => {
            if (PathExcludeHelper.isValid(value)) {
              text.inputEl.removeClass('lct-setting-invalid');
              this.settingsService.update('excludePaths', value);

              return;
            }

            text.inputEl.addClass('lct-setting-invalid');
          })
      );

    new Setting(containerEl)
      .setName(this.plugin.t('setting.keep.name'))
      .setDesc(this.plugin.t('setting.keep.desc'))
      .addDropdown((dropdown: DropdownComponent): DropdownComponent =>
        dropdown
          .addOption(KeepHistory.app, this.plugin.t('setting.keep.option.app'))
          .addOption(KeepHistory.file, this.plugin.t('setting.keep.option.file'))
          .setValue(this.settingsService.value('keep'))
          .onChange((value: KeepHistory): void => {
            this.settingsService.update('keep', value);
          })
      );

    new Setting(containerEl)
      .setName(this.plugin.t('setting.ignore-new-files.name'))
      .setDesc(this.plugin.t('setting.ignore-new-files.desc'))
      .addToggle((toggle: ToggleComponent): ToggleComponent =>
        toggle
          .setValue(this.settingsService.value('ignoreNewFiles'))
          .onChange((value: boolean): void => {
            this.settingsService.update('ignoreNewFiles', value);
          })
      );

    new Setting(containerEl)
      .setName(this.plugin.t('setting.persist.name'))
      .setDesc(this.plugin.t('setting.persist.desc'))
      .addToggle((toggle: ToggleComponent): ToggleComponent =>
        toggle
          .setValue(this.settingsService.value('persist'))
          .onChange((value: boolean): void => {
            this.settingsService.update('persist', value);
          })
      );

    new Setting(containerEl)
      .setName(this.plugin.t('setting.max-entries.name'))
      .setDesc(this.plugin.t('setting.max-entries.desc'))
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
      .setName(this.plugin.t('setting.max-age-days.name'))
      .setDesc(this.plugin.t('setting.max-age-days.desc'))
      .addText((text: TextComponent): TextComponent =>
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.retention.maxAgeDays))
          .setValue(String(this.settingsService.value('retention.maxAgeDays')))
          .onChange((value: string): void => {
            const days: number = this.toCount(value, DEFAULT_SETTINGS.retention.maxAgeDays);

            this.settingsService.update('retention.maxAgeDays', days);
          })
      );

    new Setting(containerEl)
      .setName(this.plugin.t('setting.max-deleted-entries.name'))
      .setDesc(this.plugin.t('setting.max-deleted-entries.desc'))
      .addText((text: TextComponent): TextComponent =>
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.retention.maxDeletedEntries))
          .setValue(String(this.settingsService.value('retention.maxDeletedEntries')))
          .onChange((value: string): void => {
            const count: number = this.toCount(value, DEFAULT_SETTINGS.retention.maxDeletedEntries);

            this.settingsService.update('retention.maxDeletedEntries', count);
          })
      );

    new Setting(containerEl)
      .setName(this.plugin.t('setting.max-deleted-age-days.name'))
      .setDesc(this.plugin.t('setting.max-deleted-age-days.desc'))
      .addText((text: TextComponent): TextComponent =>
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.retention.maxDeletedAgeDays))
          .setValue(String(this.settingsService.value('retention.maxDeletedAgeDays')))
          .onChange((value: string): void => {
            const days: number = this.toCount(value, DEFAULT_SETTINGS.retention.maxDeletedAgeDays);

            this.settingsService.update('retention.maxDeletedAgeDays', days);
          })
      );

    new Setting(containerEl)
      .setName(this.plugin.t('setting.snapshots-heading'))
      .setHeading();

    new Setting(containerEl)
      .setName(this.plugin.t('setting.snapshots-enabled.name'))
      .setDesc(this.plugin.t('setting.snapshots-enabled.desc'))
      .addToggle((toggle: ToggleComponent): ToggleComponent =>
        toggle
          .setValue(this.settingsService.value('snapshots.enabled'))
          .onChange((value: boolean): void => {
            this.settingsService.update('snapshots.enabled', value);
          })
      );

    new Setting(containerEl)
      .setName(this.plugin.t('setting.snapshots-edit-threshold.name'))
      .setDesc(this.plugin.t('setting.snapshots-edit-threshold.desc'))
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
      .setName(this.plugin.t('setting.snapshots-interval.name'))
      .setDesc(this.plugin.t('setting.snapshots-interval.desc'))
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
      .setName(this.plugin.t('setting.max-version-age-days.name'))
      .setDesc(this.plugin.t('setting.max-version-age-days.desc'))
      .addText((text: TextComponent): TextComponent =>
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.snapshots.maxVersionAgeDays))
          .setValue(String(this.settingsService.value('snapshots.maxVersionAgeDays')))
          .onChange((value: string): void => {
            this.settingsService.update(
              'snapshots.maxVersionAgeDays',
              this.toCount(value, DEFAULT_SETTINGS.snapshots.maxVersionAgeDays)
            );
          })
      );

    new Setting(containerEl)
      .setName(this.plugin.t('setting.max-versions.name'))
      .setDesc(this.plugin.t('setting.max-versions.desc'))
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

    new Setting(containerEl)
      .setName(this.plugin.t('setting.show-heading'))
      .setHeading();

    new Setting(containerEl)
      .setDesc(this.plugin.t('setting.show.desc'));

    new Setting(containerEl)
      .setName(this.plugin.t('setting.show.changed'))
      .addToggle((toggle: ToggleComponent): ToggleComponent =>
        toggle
          .setValue(this.settingsService.value('show.changed'))
          .onChange((value: boolean): void => {
            this.settingsService.update('show.changed', value);
          })
      );

    new Setting(containerEl)
      .setName(this.plugin.t('setting.show.restored'))
      .addToggle((toggle: ToggleComponent): ToggleComponent =>
        toggle
          .setValue(this.settingsService.value('show.restored'))
          .onChange((value: boolean): void => {
            this.settingsService.update('show.restored', value);
          })
      );

    new Setting(containerEl)
      .setName(this.plugin.t('setting.show.added'))
      .addToggle((toggle: ToggleComponent): ToggleComponent =>
        toggle
          .setValue(this.settingsService.value('show.added'))
          .onChange((value: boolean): void => {
            this.settingsService.update('show.added', value);
          })
      );

    new Setting(containerEl)
      .setName(this.plugin.t('setting.show.removed'))
      .addToggle((toggle: ToggleComponent): ToggleComponent =>
        toggle
          .setValue(this.settingsService.value('show.removed'))
          .onChange((value: boolean): void => {
            this.settingsService.update('show.removed', value);
          })
      );

    new Setting(containerEl)
      .setName(this.plugin.t('setting.line-heading'))
      .setHeading();

    new Setting(containerEl)
      .setName(this.plugin.t('setting.line-width.name'))
      .setDesc(this.plugin.t('setting.line-width.desc'))
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
      .setName(this.plugin.t('setting.gutter-heading.name'))
      .setDesc(((): DocumentFragment => {
        return DomHelper.createFragment([
          {
            tag: 'div',
            children: [
              {
                tag: 'span',
                text: this.plugin.t('setting.gutter-heading.prefix')
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
                text: this.plugin.t('setting.gutter-heading.suffix')
              }
            ]
          }
        ]);
      })())
      .setHeading();

    new Setting(containerEl)
      .setName(this.plugin.t('setting.gutter-changed.name'))
      .addText((text: TextComponent): TextComponent => {
        this.constrainGutterCharInput(text);

        return text
          .setPlaceholder(DEFAULT_SETTINGS.gutter.changed)
          .setValue(this.settingsService.value('gutter.changed'))
          .onChange((value): void => {
            this.settingsService.update('gutter.changed', value || DEFAULT_SETTINGS.gutter.changed);
          });
      });

    new Setting(containerEl)
      .setName(this.plugin.t('setting.gutter-added.name'))
      .addText((text: TextComponent): TextComponent => {
        this.constrainGutterCharInput(text);

        return text
          .setPlaceholder(DEFAULT_SETTINGS.gutter.added)
          .setValue(this.settingsService.value('gutter.added'))
          .onChange((value): void => {
            this.settingsService.update('gutter.added', value || DEFAULT_SETTINGS.gutter.added);
          });
      });

    new Setting(containerEl)
      .setName(this.plugin.t('setting.gutter-restored.name'))
      .addText((text: TextComponent): TextComponent => {
        this.constrainGutterCharInput(text);

        return text
          .setPlaceholder(DEFAULT_SETTINGS.gutter.restored)
          .setValue(this.settingsService.value('gutter.restored'))
          .onChange((value): void => {
            this.settingsService.update('gutter.restored', value || DEFAULT_SETTINGS.gutter.restored);
          });
      });

    new Setting(containerEl)
      .setName(this.plugin.t('setting.gutter-removed.name'))
      .addText((text: TextComponent): TextComponent => {
        this.constrainGutterCharInput(text);

        return text
          .setPlaceholder(DEFAULT_SETTINGS.gutter.removed)
          .setValue(this.settingsService.value('gutter.removed'))
          .onChange((value): void => {
            this.settingsService.update('gutter.removed', value || DEFAULT_SETTINGS.gutter.removed);
          });
      });
  }

  /**
   * Constrains a gutter symbol text input to a single character and a narrow
   * width sized for roughly two characters.
   *
   * Caps the underlying input to one character via the native maxLength
   * attribute and tags it with the lct-gutter-char-input class, which the
   * stylesheet sizes to about two characters wide.
   *
   * @param {TextComponent} text - The gutter symbol text component to constrain
   * @return {void}
   */
  protected constrainGutterCharInput(text: TextComponent): void {
    text.inputEl.maxLength = 1;
    text.inputEl.addClass('lct-gutter-char-input');
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
