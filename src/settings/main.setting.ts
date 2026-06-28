import { DEFAULT_SETTINGS, IndicatorType, KeepHistory } from '@/consts';
import { Inject } from '@/decorators/inject.decorator';
import { DomHelper } from '@/helpers/dom.helper';
import { PathExcludeHelper } from '@/helpers/path-exclude.helper';
import type LineChangeTrackerPlugin from '@/main';
import type { ModalsService } from '@/services/modals.service';
import type { SettingsService } from '@/services/settings.service';
import type { SnapshotsService } from '@/services/snapshots.service';
import { TOKENS } from '@/services/tokens';
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
 * The excluded-paths group manages its pattern list dynamically, mirroring the
 * obsidian-memory plugin's ignore-globs editor: the group header carries a "+"
 * button, each pattern renders as a display row with ghost edit/remove
 * icon-buttons, and editing happens inline (text field spanning the free row
 * width, save/cancel icon-buttons, Enter saves, Escape cancels). An invalid
 * pattern surfaces an inline error under the field and the row stays in edit
 * mode, so a typo is never persisted. After a persisted mutation only the
 * pattern rows rebuild in place; the rest of the tab keeps its DOM.
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
   * The "Excluded paths" group, kept so a persisted pattern mutation can
   * rebuild the pattern rows in place without re-rendering the whole tab.
   */
  protected excludeGroup?: SettingGroup;

  /**
   * Every dynamic row currently in the excluded-paths group (the empty-state
   * hint, pattern rows, and the unsaved new-pattern row). Tracked so
   * {@link refreshPatternRows} can remove exactly the rows this editor owns,
   * leaving the group header, its "+" button, and the static rows intact.
   */
  protected excludeRows: Setting[] = [];

  /**
   * The empty-state hint row, present only while the pattern list is empty.
   * Hidden in place while an unsaved new-pattern row is open.
   */
  protected excludeHint?: Setting;

  /**
   * The unsaved new-pattern row, if the user is currently adding one. Guards
   * the "+" button against stacking multiple unsaved rows.
   */
  protected newPatternRow?: Setting;

  /** The text component of the unsaved new-pattern row, for re-focus. */
  protected newPatternInput?: TextComponent;

  /**
   * The case-sensitivity toggle row, the last static row of the excluded-paths
   * group. Dynamic pattern rows must render above it, but the group can only
   * append, so {@link placePatternRow} uses this row as the insertion anchor
   * when rebuilding rows after the initial render.
   */
  protected caseSensitiveRow?: Setting;

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
   * native "+" button, a description row, one dynamic row per configured
   * pattern (second in the group, right under the description), and the
   * case-sensitivity toggle last. The toggle row doubles as the insertion
   * anchor that keeps refreshed pattern rows above it (see
   * {@link placePatternRow}).
   *
   * @param {HTMLElement} containerEl - The settings tab container
   */
  protected renderExcludePaths(containerEl: HTMLElement): void {
    const group: SettingGroup = new SettingGroup(containerEl)
      .setHeading(this.plugin.t('setting.exclude-paths.name'));

    this.excludeGroup = group;
    this.caseSensitiveRow = undefined;

    group.addExtraButton((button: ExtraButtonComponent): ExtraButtonComponent =>
      button
        .setIcon('plus')
        .setTooltip(this.plugin.t('setting.exclude-paths.add'))
        .onClick((): void => {
          this.startAddPattern(group);
        })
    );

    group.addSetting((setting: Setting): void => {
      setting.setDesc(this.plugin.t('setting.exclude-paths.desc'));
    });

    this.renderPatternRows(group, [...this.settingsService.value('excludePaths')]);

    group.addSetting((setting: Setting): void => {
      this.caseSensitiveRow = setting;
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
   * Tracks a dynamic pattern row and keeps it above the case-sensitivity
   * toggle. On the initial render the toggle does not exist yet, so rows stay
   * where the group appended them (right after the description); on an
   * in-place refresh or an added row the group appends to its end, which is
   * below the toggle, so the row's element is moved up before the anchor.
   *
   * @param {Setting} setting - The freshly appended dynamic row
   */
  protected placePatternRow(setting: Setting): void {
    this.excludeRows.push(setting);

    this.caseSensitiveRow?.settingEl.before(setting.settingEl);
  }

  /**
   * Renders the dynamic pattern rows into the group: a hint row while the list
   * is empty, otherwise one display-mode row per pattern. Resets the
   * row-tracking state first, so the call is also the second half of an
   * in-place refresh.
   *
   * @param {SettingGroup} group - The "Excluded paths" native setting group
   * @param {string[]} patterns - The pattern list to render rows for
   */
  protected renderPatternRows(group: SettingGroup, patterns: string[]): void {
    this.excludeHint = undefined;
    this.newPatternRow = undefined;
    this.newPatternInput = undefined;
    this.excludeRows = [];

    if (patterns.length === 0) {
      group.addSetting((setting: Setting): void => {
        this.placePatternRow(setting);
        this.excludeHint = setting.setDesc(this.plugin.t('setting.exclude-paths.empty'));
      });
    }

    patterns.forEach((pattern: string, index: number): void => {
      group.addSetting((setting: Setting): void => {
        this.placePatternRow(setting);
        this.renderPatternDisplay(setting, pattern, index);
      });
    });
  }

  /**
   * Rebuilds the pattern rows in place after a persisted mutation: removes
   * every dynamic row this editor added to the group (the header, its "+"
   * button, and the static rows stay) and renders fresh rows from the given
   * list. No-ops when the group has not rendered yet.
   *
   * @param {string[]} patterns - The persisted pattern list the rows must match
   */
  protected refreshPatternRows(patterns: string[]): void {
    const group: SettingGroup | undefined = this.excludeGroup;

    if (!group) {
      return;
    }

    for (const row of this.excludeRows) {
      row.settingEl.remove();
    }

    this.renderPatternRows(group, patterns);
  }

  /**
   * Renders (or restores) a pattern row's display mode: the pattern as the row
   * name plus ghost edit and remove icon-buttons. Edit swaps the same row into
   * edit mode in place; remove persists the shortened list.
   *
   * @param {Setting} setting - The row to render into (cleared first)
   * @param {string} pattern - The pattern this row shows
   * @param {number} index - The index of the pattern in the list
   */
  protected renderPatternDisplay(setting: Setting, pattern: string, index: number): void {
    setting.clear();
    setting.controlEl.empty();
    setting.settingEl.removeClass('lct-exclude-edit');
    setting.setName(pattern);

    setting.addExtraButton((button: ExtraButtonComponent): ExtraButtonComponent =>
      button
        .setIcon('pencil')
        .setTooltip(this.plugin.t('setting.exclude-paths.edit'))
        .onClick((): void => {
          this.renderPatternEditor(
            setting,
            pattern,
            (value: string): string | null => this.replacePattern(index, value),
            (): void => {
              this.renderPatternDisplay(setting, pattern, index);
            }
          );
        })
    );

    setting.addExtraButton((button: ExtraButtonComponent): ExtraButtonComponent =>
      button
        .setIcon('trash')
        .setTooltip(this.plugin.t('setting.exclude-paths.remove'))
        .onClick((): void => {
          this.removePattern(index);
        })
    );
  }

  /**
   * Swaps a pattern row into edit mode: a text field spanning the free row
   * width plus save/cancel icon-buttons. Enter saves, Escape cancels. A failed
   * save surfaces the validation message inline under the field and keeps the
   * row in edit mode; a successful save persists, which rebuilds the pattern
   * rows in place.
   *
   * @param {Setting} setting - The row to render into (cleared first)
   * @param {string} initial - The initial field value (the current pattern, or
   *   empty for a new row)
   * @param {(value: string) => string | null} commit - Persists the entered
   *   value; returns an error message to surface inline, or null on success
   * @param {() => void} cancel - Restores the row (or removes it, for an
   *   unsaved new row)
   * @return {TextComponent | undefined} The text component, for re-focus
   */
  protected renderPatternEditor(
    setting: Setting,
    initial: string,
    commit: (value: string) => string | null,
    cancel: () => void
  ): TextComponent | undefined {
    setting.clear();
    setting.controlEl.empty();
    setting.setName('');
    setting.settingEl.addClass('lct-exclude-edit');

    /**
     * The inline error line: a flex child that wraps to its own full-width
     * line after the field and buttons (see `.lct-exclude-edit` in styles).
     */
    const errorEl: HTMLElement = setting.controlEl.createDiv({ cls: 'lct-setting-error' });

    let input: TextComponent | undefined;

    const save = (): void => {
      const message: string | null = commit(input?.getValue() ?? '');

      errorEl.setText(message ?? '');
    };

    setting.addText((text: TextComponent): void => {
      input = text;
      text.setPlaceholder(this.plugin.t('setting.exclude-paths.placeholder')).setValue(initial);
      text.inputEl.addEventListener('keydown', (event: KeyboardEvent): void => {
        if (event.key === 'Enter') {
          event.preventDefault();
          save();

          return;
        }

        if (event.key === 'Escape') {
          event.preventDefault();
          cancel();
        }
      });
    });

    setting.addExtraButton((button: ExtraButtonComponent): ExtraButtonComponent =>
      button
        .setIcon('check')
        .setTooltip(this.plugin.t('setting.exclude-paths.save'))
        .onClick((): void => {
          save();
        })
    );

    setting.addExtraButton((button: ExtraButtonComponent): ExtraButtonComponent =>
      button
        .setIcon('x')
        .setTooltip(this.plugin.t('setting.exclude-paths.cancel'))
        .onClick((): void => {
          cancel();
        })
    );

    input?.inputEl.focus();

    return input;
  }

  /**
   * Appends a new unsaved pattern row already in edit mode. When such a row is
   * already open, re-focuses it instead of stacking another. The empty-state
   * hint hides while the unsaved row is open and returns on cancel; a
   * successful save persists and rebuilds the pattern rows in place.
   *
   * @param {SettingGroup} group - The native setting group the row is appended to
   */
  protected startAddPattern(group: SettingGroup): void {
    if (this.newPatternRow) {
      this.newPatternInput?.inputEl.focus();

      return;
    }

    this.excludeHint?.settingEl.addClass('lct-row-hidden');

    group.addSetting((setting: Setting): void => {
      this.placePatternRow(setting);
      this.newPatternRow = setting;
      this.newPatternInput = this.renderPatternEditor(
        setting,
        '',
        (value: string): string | null => this.appendPattern(value),
        (): void => {
          setting.settingEl.remove();
          this.excludeRows = this.excludeRows.filter((row: Setting): boolean => row !== setting);
          this.newPatternRow = undefined;
          this.newPatternInput = undefined;
          this.excludeHint?.settingEl.removeClass('lct-row-hidden');
        }
      );
    });
  }

  /**
   * Validates a candidate exclude pattern: it must be non-blank and compile as
   * a regular expression. Blank entries are rejected here even though the
   * matcher tolerates them, because a stored blank row is dead weight the user
   * would have to clean up by hand.
   *
   * @param {string} value - The trimmed candidate pattern
   * @return {string | null} An error message, or null when the pattern is valid
   */
  protected validatePattern(value: string): string | null {
    if (value === '' || !PathExcludeHelper.isValid(value)) {
      return this.plugin.t('setting.exclude-paths.error');
    }

    return null;
  }

  /**
   * Validates and persists a replacement for the pattern at `index`. The list
   * is re-read from the settings service at invocation time so edits made
   * since the rows rendered are preserved.
   *
   * @param {number} index - The index of the pattern being edited
   * @param {string} value - The raw field value
   * @return {string | null} An error message to surface inline, or null once
   *   persisted
   */
  protected replacePattern(index: number, value: string): string | null {
    const trimmed: string = value.trim();
    const message: string | null = this.validatePattern(trimmed);

    if (message !== null) {
      return message;
    }

    const next: string[] = [...this.settingsService.value('excludePaths')];

    next[index] = trimmed;
    this.persistPatterns(next);

    return null;
  }

  /**
   * Validates and persists a new pattern appended to the list. The list is
   * re-read from the settings service at invocation time so edits made since
   * the rows rendered are preserved.
   *
   * @param {string} value - The raw field value
   * @return {string | null} An error message to surface inline, or null once
   *   persisted
   */
  protected appendPattern(value: string): string | null {
    const trimmed: string = value.trim();
    const message: string | null = this.validatePattern(trimmed);

    if (message !== null) {
      return message;
    }

    this.persistPatterns([...this.settingsService.value('excludePaths'), trimmed]);

    return null;
  }

  /**
   * Removes the pattern at `index` and rebuilds the pattern rows in place.
   *
   * @param {number} index - The index of the pattern to remove
   */
  protected removePattern(index: number): void {
    const next: string[] = this.settingsService
      .value('excludePaths')
      .filter((_pattern: string, at: number): boolean => at !== index);

    this.persistPatterns(next);
  }

  /**
   * Persists a replacement pattern list and rebuilds the pattern rows in place
   * so they match the persisted list. Only the dynamic rows are touched: the
   * rest of the tab keeps its DOM and focus.
   *
   * @param {string[]} patterns - The full replacement pattern list
   */
  protected persistPatterns(patterns: string[]): void {
    this.settingsService.update('excludePaths', patterns);
    this.refreshPatternRows(patterns);
    this.updatePurgeButtonState();
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
