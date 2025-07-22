import { DEFAULT_SETTINGS, PluginEvent } from '@/consts';
import type LineChangeTrackerPlugin from '@/main';
import { MainSetting } from '@/settings/main.setting';
import type { DeepValue, LineChangeTrackerSettings, PathTo, PathValue, Service } from '@/types';
import { get, set } from 'lodash-es';

/**
 * Service responsible for managing plugin settings.
 * Provides methods to access and update settings values.
 * Handles saving settings to disk and notifying other components when settings change.
 *
 * @implements {Service}
 */
export class SettingsService implements Service {
  /**
   * The plugin settings data.
   * Initialized with default settings and updated from saved data during initialization.
   */
  protected data: LineChangeTrackerSettings = DEFAULT_SETTINGS;

  /**
   * Creates a new instance of SettingsService.
   *
   * @param {LineChangeTrackerPlugin} plugin - The plugin instance
   */
  public constructor(
    protected plugin: LineChangeTrackerPlugin,
  ) {
  }

  /**
   * Initializes the service.
   * Loads saved settings data and added the settings tab to the plugin.
   */
  public async init(): Promise<void> {
    this.data = Object.assign({}, DEFAULT_SETTINGS, await this.plugin.loadData());
    this.plugin.addSettingTab(new MainSetting(this.plugin.app, this.plugin));
  }

  /**
   * Gets a copy of all settings values.
   *
   * @return {LineChangeTrackerSettings} A copy of the settings data
   */
  public values(): LineChangeTrackerSettings {
    return { ...this.data };
  }

  /**
   * Updates a specific setting value.
   * Saves the updated settings to disk, forces an editor update,
   * and emits a settings update event.
   *
   * @template Path - The path to the setting
   * @template Value - The type of the setting value
   * @param {Path} path - The path to the setting to update
   * @param {Value} value - The new value for the setting
   */
  public update<
    Path extends PathTo<LineChangeTrackerSettings>,
    Value extends PathValue<LineChangeTrackerSettings, Path>
  >(path: Path, value: Value): void {
    set(this.data, path, value);

    void this.plugin.saveData(this.data);
    this.plugin.forceUpdateEditor();
    this.plugin.emit(PluginEvent.settingsUpdate, { key: path, value });
  }

  /**
   * Gets a value from the settings by path.
   * Supports accessing nested properties using dot notation.
   *
   * @template Path - The path to the setting
   * @param {Path} path - The path to the setting to retrieve
   * @return {*} The value at the specified path
   */
  public value<
    Path extends PathTo<LineChangeTrackerSettings>
  >(path: Path): DeepValue<LineChangeTrackerSettings, Path> {
    return get(this.data, path) as DeepValue<LineChangeTrackerSettings, Path>;
  }
}
