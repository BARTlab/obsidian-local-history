import { DEFAULT_SETTINGS, IndicatorType, KeepHistory } from '@/consts';
import { Inject } from '@/decorators/inject.decorator';
import * as DomHelper from '@/helpers/dom.helper';
import type LineChangeTrackerPlugin from '@/main';
import type { ModalsService } from '@/services/modals.service';
import type { SettingsService } from '@/services/settings.service';
import type { SnapshotsService } from '@/services/snapshots.service';
import { TOKENS } from '@/services/tokens';
import { ExcludePatternsEditor } from '@/settings/exclude-patterns-editor';
import {
  type ButtonComponent,
  type DropdownComponent,
  type ExtraButtonComponent,
  Notice,
  PluginSettingTab,
  type Setting,
  SettingGroup,
  type SliderComponent,
  type TextComponent,
  type ToggleComponent
} from 'obsidian';

/**
 * The four stored-history retention caps rendered in the cleanup group, keyed
 * by their `retention.*` settings path segment.
 */
type RetentionKey = 'maxEntries' | 'maxAgeDays' | 'maxDeletedEntries' | 'maxDeletedAgeDays';

/**
 * Settings tab for the Line Change Tracker plugin.
 *
 * The tab renders native setting groups (Obsidian's SettingGroup, app 1.11+)
 * in a fixed order: General, Excluded paths, Timeline snapshots, Show
 * indicator for, Line indicator, Gutter indicator, History cleanup. Cleanup
 * lives last on purpose: it gathers every destructive or retention knob
 * (keep strategy, retention caps, the purge button) at the bottom of the tab.
 *
 * The excluded-paths group's dynamic pattern list is owned by
 * {@link ExcludePatternsEditor}; the tab keeps the section wiring (the group,
 * its "+" button, the description row, and the case-sensitivity toggle).
 *
 * @extends PluginSettingTab
 */
export class MainSetting extends PluginSettingTab {
  @Inject(TOKENS.settings)
  protected settingsService!: SettingsService;

  @Inject(TOKENS.snapshots)
  protected snapshotsService!: SnapshotsService;

  /**
   * Used by the purge button to gate the irreversible history purge behind a
   * confirmation dialog.
   */
  @Inject(TOKENS.modals)
  protected modalsService!: ModalsService;

  /**
   * The plugin instance.
   * Used to access plugin functionality.
   * Declared (not assigned) here only to narrow the inherited
   * `PluginSettingTab.plugin` field to the concrete plugin type; the base
   * constructor assigns it at runtime.
   */
  public declare plugin: LineChangeTrackerPlugin;

  /**
   * The dynamic pattern-list editor of the excluded-paths group. Reads the
   * current list, persists a replacement (and syncs the purge button), and
   * translates through this tab; the tab keeps the surrounding section wiring.
   */
  protected readonly excludePatternsEditor: ExcludePatternsEditor = new ExcludePatternsEditor({
    getPatterns: (): string[] => this.settingsService.value('excludePaths'),
    persist: (patterns: string[]): void => {
      this.settingsService.update('excludePaths', patterns);
      this.updatePurgeButtonState();
    },
    t: (key: string): string => this.plugin.t(key),
  });

  /**
   * The purge button of the history-cleanup group. Kept so a pattern-list
   * mutation can refresh its disabled state in place: with no exclude patterns
   * configured the purge is a guaranteed no-op, so the button stays disabled
   * instead of letting the user confirm an action that does nothing.
   */
  protected purgeButton?: ButtonComponent;

  /**
   * Renders the settings UI as native setting groups in a fixed order, with
   * the history-cleanup group (keep strategy, retention caps, purge) last.
   * Safe to call again on reopen: the container is emptied first.
   */
  public display(): void {
    const { containerEl } = this;

    containerEl.empty();

    this.renderGeneral(containerEl);
    this.renderExcludePaths(containerEl);
    this.renderSnapshots(containerEl);
    this.renderShow(containerEl);
    this.renderLine(containerEl);
    this.renderGutter(containerEl);
    this.renderCleanup(containerEl);
  }

  /**
   * Renders the "General" group: indicator type, tracked extensions, the
   * new-files filter, the three highlight surfaces (file tree, properties
   * panel, reading mode), and history persistence.
   *
   * @param {HTMLElement} containerEl - The settings tab container
   */
  protected renderGeneral(containerEl: HTMLElement): void {
    const group: SettingGroup = new SettingGroup(containerEl)
      .setHeading(this.plugin.t('setting.general-heading'));

    group.addSetting((setting: Setting): void => {
      setting
        .setName(this.plugin.t('setting.type.name'))
        .setDesc(this.plugin.t('setting.type.desc'))
        .addDropdown((dropdown: DropdownComponent): DropdownComponent =>
          dropdown
            .addOption(IndicatorType.line, this.plugin.t('setting.type.option.line'))
            .addOption(IndicatorType.dot, this.plugin.t('setting.type.option.dot'))
            .setValue(this.settingsService.value('type'))
            .onChange((value: string): void => {
              this.settingsService.update('type', value as IndicatorType);
            })
        );
    });

    group.addSetting((setting: Setting): void => {
      setting
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
    });

    group.addSetting((setting: Setting): void => {
      setting
        .setName(this.plugin.t('setting.ignore-new-files.name'))
        .setDesc(this.plugin.t('setting.ignore-new-files.desc'))
        .addToggle((toggle: ToggleComponent): ToggleComponent =>
          toggle
            .setValue(this.settingsService.value('ignoreNewFiles'))
            .onChange((value: boolean): void => {
              this.settingsService.update('ignoreNewFiles', value);
            })
        );
    });

    group.addSetting((setting: Setting): void => {
      setting
        .setName(this.plugin.t('setting.tree-highlight.name'))
        .setDesc(this.plugin.t('setting.tree-highlight.desc'))
        .addToggle((toggle: ToggleComponent): ToggleComponent =>
          toggle
            .setValue(this.settingsService.value('treeHighlight'))
            .onChange((value: boolean): void => {
              this.settingsService.update('treeHighlight', value);
            })
        );
    });

    group.addSetting((setting: Setting): void => {
      setting
        .setName(this.plugin.t('setting.properties-highlight.name'))
        .setDesc(this.plugin.t('setting.properties-highlight.desc'))
        .addToggle((toggle: ToggleComponent): ToggleComponent =>
          toggle
            .setValue(this.settingsService.value('propertiesHighlight'))
            .onChange((value: boolean): void => {
              this.settingsService.update('propertiesHighlight', value);
            })
        );
    });

    group.addSetting((setting: Setting): void => {
      setting
        .setName(this.plugin.t('setting.reading-mode-indicator.name'))
        .setDesc(this.plugin.t('setting.reading-mode-indicator.desc'))
        .addToggle((toggle: ToggleComponent): ToggleComponent =>
          toggle
            .setValue(this.settingsService.value('readingModeIndicator'))
            .onChange((value: boolean): void => {
              this.settingsService.update('readingModeIndicator', value);
            })
        );
    });

    group.addSetting((setting: Setting): void => {
      setting
        .setName(this.plugin.t('setting.persist.name'))
        .setDesc(this.plugin.t('setting.persist.desc'))
        .addToggle((toggle: ToggleComponent): ToggleComponent =>
          toggle
            .setValue(this.settingsService.value('persist'))
            .onChange((value: boolean): void => {
              this.settingsService.update('persist', value);
            })
        );
    });
  }

  /**
   * Renders the "Excluded paths" group: the add control as the group header's
   * native "+" button, a description row, the dynamic pattern rows (owned by
   * {@link ExcludePatternsEditor}), and the case-sensitivity toggle last. The
   * toggle row doubles as the insertion anchor that keeps refreshed pattern rows
   * above it.
   *
   * @param {HTMLElement} containerEl - The settings tab container
   */
  protected renderExcludePaths(containerEl: HTMLElement): void {
    const group: SettingGroup = new SettingGroup(containerEl)
      .setHeading(this.plugin.t('setting.exclude-paths.name'));

    group.addExtraButton((button: ExtraButtonComponent): ExtraButtonComponent =>
      button
        .setIcon('plus')
        .setTooltip(this.plugin.t('setting.exclude-paths.add'))
        .onClick((): void => {
          this.excludePatternsEditor.startAdd();
        })
    );

    group.addSetting((setting: Setting): void => {
      setting.setDesc(this.plugin.t('setting.exclude-paths.desc'));
    });

    this.excludePatternsEditor.render(group);

    group.addSetting((setting: Setting): void => {
      this.excludePatternsEditor.setAnchor(setting);
      setting
        .setName(this.plugin.t('setting.exclude-paths-case-sensitive.name'))
        .setDesc(this.plugin.t('setting.exclude-paths-case-sensitive.desc'))
        .addToggle((toggle: ToggleComponent): ToggleComponent =>
          toggle
            .setValue(this.settingsService.value('excludePathsCaseSensitive'))
            .onChange((value: boolean): void => {
              this.settingsService.update('excludePathsCaseSensitive', value);
            })
        );
    });
  }

  /**
   * Reports whether at least one non-blank exclude pattern is configured.
   * Drives the purge button's disabled state: with no patterns the purge
   * cannot match anything, so offering it would only invite a no-op confirm.
   *
   * @return {boolean} True when the exclude list holds a usable pattern
   */
  protected hasExcludePatterns(): boolean {
    const patterns: string[] = this.settingsService.value('excludePaths');

    return Array.isArray(patterns) && patterns.some((pattern: string): boolean => Boolean(pattern?.trim()));
  }

  /**
   * Syncs the purge button's disabled state with the exclude pattern list.
   * Called on initial render and after every persisted pattern mutation, so
   * adding the first pattern enables the button in the same settings session
   * and removing the last one disables it again.
   */
  protected updatePurgeButtonState(): void {
    this.purgeButton?.setDisabled(!this.hasExcludePatterns());
  }

  /**
   * Renders the "Timeline snapshots" group: the capture toggle, the two
   * capture triggers (edits, minutes), and the per-file version retention
   * caps. All numeric rows use compact native number inputs.
   *
   * @param {HTMLElement} containerEl - The settings tab container
   */
  protected renderSnapshots(containerEl: HTMLElement): void {
    const group: SettingGroup = new SettingGroup(containerEl)
      .setHeading(this.plugin.t('setting.snapshots-heading'));

    group.addSetting((setting: Setting): void => {
      setting
        .setName(this.plugin.t('setting.snapshots-enabled.name'))
        .setDesc(this.plugin.t('setting.snapshots-enabled.desc'))
        .addToggle((toggle: ToggleComponent): ToggleComponent =>
          toggle
            .setValue(this.settingsService.value('snapshots.enabled'))
            .onChange((value: boolean): void => {
              this.settingsService.update('snapshots.enabled', value);
            })
        );
    });

    group.addSetting((setting: Setting): void => {
      setting
        .setName(this.plugin.t('setting.snapshots-edit-threshold.name'))
        .setDesc(this.plugin.t('setting.snapshots-edit-threshold.desc'))
        .addText((text: TextComponent): TextComponent =>
          this.constrainNumberInput(text)
            .setPlaceholder(String(DEFAULT_SETTINGS.snapshots.editThreshold))
            .setValue(String(this.settingsService.value('snapshots.editThreshold')))
            .onChange((value: string): void => {
              this.settingsService.update(
                'snapshots.editThreshold',
                this.toCount(value, DEFAULT_SETTINGS.snapshots.editThreshold)
              );
            })
        );
    });

    group.addSetting((setting: Setting): void => {
      setting
        .setName(this.plugin.t('setting.snapshots-interval.name'))
        .setDesc(this.plugin.t('setting.snapshots-interval.desc'))
        .addText((text: TextComponent): TextComponent =>
          this.constrainNumberInput(text)
            .setPlaceholder(String(DEFAULT_SETTINGS.snapshots.intervalMs / 60000))
            .setValue(String(this.settingsService.value('snapshots.intervalMs') / 60000))
            .onChange((value: string): void => {
              const minutes: number = this.toCount(value, DEFAULT_SETTINGS.snapshots.intervalMs / 60000);

              this.settingsService.update('snapshots.intervalMs', minutes * 60000);
            })
        );
    });

    group.addSetting((setting: Setting): void => {
      setting
        .setName(this.plugin.t('setting.max-version-age-days.name'))
        .setDesc(this.plugin.t('setting.max-version-age-days.desc'))
        .addText((text: TextComponent): TextComponent =>
          this.constrainNumberInput(text)
            .setPlaceholder(String(DEFAULT_SETTINGS.snapshots.maxVersionAgeDays))
            .setValue(String(this.settingsService.value('snapshots.maxVersionAgeDays')))
            .onChange((value: string): void => {
              this.settingsService.update(
                'snapshots.maxVersionAgeDays',
                this.toCount(value, DEFAULT_SETTINGS.snapshots.maxVersionAgeDays)
              );
            })
        );
    });

    group.addSetting((setting: Setting): void => {
      setting
        .setName(this.plugin.t('setting.max-versions.name'))
        .setDesc(this.plugin.t('setting.max-versions.desc'))
        .addText((text: TextComponent): TextComponent =>
          this.constrainNumberInput(text)
            .setPlaceholder(String(DEFAULT_SETTINGS.snapshots.maxVersions))
            .setValue(String(this.settingsService.value('snapshots.maxVersions')))
            .onChange((value: string): void => {
              this.settingsService.update(
                'snapshots.maxVersions',
                this.toCount(value, DEFAULT_SETTINGS.snapshots.maxVersions)
              );
            })
        );
    });
  }

  /**
   * Renders the "Show indicator for" group: the reading-mode hint and the four
   * per-change-type toggles.
   *
   * @param {HTMLElement} containerEl - The settings tab container
   */
  protected renderShow(containerEl: HTMLElement): void {
    const group: SettingGroup = new SettingGroup(containerEl)
      .setHeading(this.plugin.t('setting.show-heading'));

    group.addSetting((setting: Setting): void => {
      setting.setDesc(this.plugin.t('setting.show.desc'));
    });

    const toggles: ['changed' | 'restored' | 'added' | 'removed', string][] = [
      ['changed', this.plugin.t('setting.show.changed')],
      ['restored', this.plugin.t('setting.show.restored')],
      ['added', this.plugin.t('setting.show.added')],
      ['removed', this.plugin.t('setting.show.removed')],
    ];

    toggles.forEach(([key, label]: ['changed' | 'restored' | 'added' | 'removed', string]): void => {
      group.addSetting((setting: Setting): void => {
        setting
          .setName(label)
          .addToggle((toggle: ToggleComponent): ToggleComponent =>
            toggle
              .setValue(this.settingsService.value(`show.${key}`))
              .onChange((value: boolean): void => {
                this.settingsService.update(`show.${key}`, value);
              })
          );
      });
    });
  }

  /**
   * Renders the "Line indicator" group with the width slider.
   *
   * @param {HTMLElement} containerEl - The settings tab container
   */
  protected renderLine(containerEl: HTMLElement): void {
    const group: SettingGroup = new SettingGroup(containerEl)
      .setHeading(this.plugin.t('setting.line-heading'));

    group.addSetting((setting: Setting): void => {
      setting
        .setName(this.plugin.t('setting.line-width.name'))
        .setDesc(this.plugin.t('setting.line-width.desc'))
        .addSlider((slider: SliderComponent): SliderComponent =>
          slider
            .setLimits(1, 5, 1)
            .setValue(this.settingsService.value('line.width'))
            .setDynamicTooltip()
            .onChange((value: number): void => {
              this.settingsService.update('line.width', value);
            })
        );
    });
  }

  /**
   * Renders the "Gutter indicator" group: a description row carrying the
   * unicode-table link and the four per-change-type symbol inputs.
   *
   * @param {HTMLElement} containerEl - The settings tab container
   */
  protected renderGutter(containerEl: HTMLElement): void {
    const group: SettingGroup = new SettingGroup(containerEl)
      .setHeading(this.plugin.t('setting.gutter-heading.name'));

    group.addSetting((setting: Setting): void => {
      setting.setDesc(
        DomHelper.createFragment([
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
        ])
      );
    });

    const symbols: ['changed' | 'added' | 'restored' | 'removed', string][] = [
      ['changed', this.plugin.t('setting.gutter-changed.name')],
      ['added', this.plugin.t('setting.gutter-added.name')],
      ['restored', this.plugin.t('setting.gutter-restored.name')],
      ['removed', this.plugin.t('setting.gutter-removed.name')],
    ];

    symbols.forEach(([key, label]: ['changed' | 'added' | 'restored' | 'removed', string]): void => {
      group.addSetting((setting: Setting): void => {
        setting
          .setName(label)
          .addText((text: TextComponent): TextComponent => {
            this.constrainGutterCharInput(text);

            return text
              .setPlaceholder(DEFAULT_SETTINGS.gutter[key])
              .setValue(this.settingsService.value(`gutter.${key}`))
              .onChange((value: string): void => {
                this.settingsService.update(`gutter.${key}`, value || DEFAULT_SETTINGS.gutter[key]);
              });
          });
      });
    });
  }

  /**
   * Renders the "History cleanup" group, deliberately last in the tab: the
   * keep strategy, the four stored-history retention caps, and the
   * purge-excluded button. Everything that deletes or expires history lives
   * here, so the destructive surface sits at the bottom of the settings.
   *
   * @param {HTMLElement} containerEl - The settings tab container
   */
  protected renderCleanup(containerEl: HTMLElement): void {
    const group: SettingGroup = new SettingGroup(containerEl)
      .setHeading(this.plugin.t('setting.cleanup-heading'));

    group.addSetting((setting: Setting): void => {
      setting
        .setName(this.plugin.t('setting.keep.name'))
        .setDesc(this.plugin.t('setting.keep.desc'))
        .addDropdown((dropdown: DropdownComponent): DropdownComponent =>
          dropdown
            .addOption(KeepHistory.app, this.plugin.t('setting.keep.option.app'))
            .addOption(KeepHistory.file, this.plugin.t('setting.keep.option.file'))
            .setValue(this.settingsService.value('keep'))
            .onChange((value: string): void => {
              this.settingsService.update('keep', value as KeepHistory);
            })
        );
    });

    const caps: [RetentionKey, string, string][] = [
      ['maxEntries', this.plugin.t('setting.max-entries.name'), this.plugin.t('setting.max-entries.desc')],
      ['maxAgeDays', this.plugin.t('setting.max-age-days.name'), this.plugin.t('setting.max-age-days.desc')],
      [
        'maxDeletedEntries',
        this.plugin.t('setting.max-deleted-entries.name'),
        this.plugin.t('setting.max-deleted-entries.desc')
      ],
      [
        'maxDeletedAgeDays',
        this.plugin.t('setting.max-deleted-age-days.name'),
        this.plugin.t('setting.max-deleted-age-days.desc')
      ],
    ];

    caps.forEach(([key, name, desc]: [RetentionKey, string, string]): void => {
      group.addSetting((setting: Setting): void => {
        setting
          .setName(name)
          .setDesc(desc)
          .addText((text: TextComponent): TextComponent =>
            this.constrainNumberInput(text)
              .setPlaceholder(String(DEFAULT_SETTINGS.retention[key]))
              .setValue(String(this.settingsService.value(`retention.${key}`)))
              .onChange((value: string): void => {
                this.settingsService.update(
                  `retention.${key}`,
                  this.toCount(value, DEFAULT_SETTINGS.retention[key])
                );
              })
          );
      });
    });

    group.addSetting((setting: Setting): void => {
      setting
        .setName(this.plugin.t('setting.purge-excluded.name'))
        .setDesc(this.plugin.t('setting.purge-excluded.desc'))
        .addButton((button: ButtonComponent) => {
          this.purgeButton = button;
          this.updatePurgeButtonState();

          return button
            .setButtonText(this.plugin.t('setting.purge-excluded.name'))
            .setWarning()
            .onClick(async (): Promise<void> => {
              /**
               * The purge is irreversible, so it is gated behind a confirm
               * dialog. The dialog reuses the setting's own name/desc keys:
               * the desc already states exactly what is deleted and that the
               * action cannot be undone, so no extra catalog keys are needed.
               */
              const confirmed: boolean = await this.modalsService.confirm({
                title: this.plugin.t('setting.purge-excluded.name'),
                message: this.plugin.t('setting.purge-excluded.desc'),
                confirmText: this.plugin.t('setting.purge-excluded.name'),
                cancelText: this.plugin.t('modal.confirm.cancel'),
              });

              if (!confirmed) {
                return;
              }

              const count: number = this.snapshotsService.purgeExcluded();

              /**
               * A zero count means the configured patterns matched no stored
               * history; say that explicitly instead of reporting "purged 0",
               * which reads as if the purge silently failed.
               */
              const message: string = count === 0
                ? this.plugin.t('notice.purge-excluded.no-match')
                : this.plugin.t('notice.purge-excluded').replace('{count}', String(count));

              new Notice(message);
            });
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
   * Turns a settings-row text component into a compact integer input: native
   * `type="number"` (the browser blocks non-numeric characters and renders a
   * stepper), a zero lower bound, an integer step, and the narrow width class
   * from the stylesheet so the field's size matches the few digits it expects.
   *
   * The change handlers keep parsing the string value through {@link toCount}:
   * on invalid intermediate input the browser reports an empty string, which
   * toCount maps to the default, so this is a usability layer, not the
   * validation layer.
   *
   * @param {TextComponent} text - The text component of the row
   * @return {TextComponent} The same component, for chaining
   */
  protected constrainNumberInput(text: TextComponent): TextComponent {
    text.inputEl.type = 'number';
    text.inputEl.min = '0';
    text.inputEl.step = '1';
    text.inputEl.addClass('lct-input-number');

    return text;
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
