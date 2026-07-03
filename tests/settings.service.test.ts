import { describe, expect, it, jest } from '@jest/globals';

// MainSetting pulls the Obsidian and settings-UI chain; replace it with a no-op
// so the settings service can be constructed and initialized in isolation.
jest.mock('@/settings/main.setting', () => ({
  MainSetting: class {},
}));

import { DEFAULT_SETTINGS } from '@/consts';
import { SettingsService } from '@/services/settings.service';

type PluginArg = ConstructorParameters<typeof SettingsService>[0];

const makeService = (saved: unknown = null): SettingsService => {
  const plugin = {
    app: {},
    loadData: async (): Promise<unknown> => saved,
    saveData: async (): Promise<void> => undefined,
    addSettingTab: (): void => undefined,
    forceUpdateEditor: (): void => undefined,
    emit: (): void => undefined,
  } as unknown as PluginArg;

  return new SettingsService(plugin);
};

describe('SettingsService init', () => {
  it('deep-merges partial saved data and keeps sibling defaults', async () => {
    const service = makeService({ show: { changed: false } });
    await service.init();

    expect(service.value('show.changed')).toBe(false);
    expect(service.value('show.restored')).toBe(true);
    expect(service.value('show.added')).toBe(true);
    expect(service.value('show.removed')).toBe(true);

    // Other nested groups and scalars stay at their defaults.
    expect(service.value('gutter.changed')).toBe(DEFAULT_SETTINGS.gutter.changed);
    expect(service.value('line.width')).toBe(DEFAULT_SETTINGS.line.width);
    expect(service.value('type')).toBe(DEFAULT_SETTINGS.type);

    // The intermediate-snapshot group keeps its defaults too.
    expect(service.value('snapshots.enabled')).toBe(DEFAULT_SETTINGS.snapshots.enabled);
    expect(service.value('snapshots.maxVersions')).toBe(DEFAULT_SETTINGS.snapshots.maxVersions);
  });

  it('deep-merges a partial snapshots group and keeps sibling snapshot defaults', async () => {
    const service = makeService({ snapshots: { editThreshold: 7 } });
    await service.init();

    expect(service.value('snapshots.editThreshold')).toBe(7);
    expect(service.value('snapshots.enabled')).toBe(DEFAULT_SETTINGS.snapshots.enabled);
    expect(service.value('snapshots.intervalMs')).toBe(DEFAULT_SETTINGS.snapshots.intervalMs);
    expect(service.value('snapshots.maxVersions')).toBe(DEFAULT_SETTINGS.snapshots.maxVersions);
  });

  it('backfills excludePaths from defaults for data saved before the setting existed', async () => {
    // Saved data from an older version has no excludePaths key; the deep-merge
    // must supply the default (an empty array) instead of leaving the key unset.
    const service = makeService({ show: { changed: false } });
    await service.init();

    expect(service.value('excludePaths')).toEqual(DEFAULT_SETTINGS.excludePaths);
    expect(service.value('excludePaths')).toEqual([]);
  });

  it('defaults gutterHoverPanel to true and backfills it for older saved data', async () => {
    const fresh = makeService(null);
    await fresh.init();
    expect(fresh.value('gutterHoverPanel')).toBe(true);

    // Data saved before the setting existed has no key; the deep-merge must
    // supply the default rather than leave the gutter hover panel undefined.
    const legacy = makeService({ show: { changed: false } });
    await legacy.init();
    expect(legacy.value('gutterHoverPanel')).toBe(true);
  });

  it('migrates a legacy excludePaths string into a single-element array (C3)', async () => {
    // Older installs stored excludePaths as a single regex string. The migration
    // shim wraps the whole string in a one-element array, preserving its exact
    // matching semantics rather than splitting on regex alternation `|`.
    const service = makeService({ excludePaths: '(^|/)Templates/|\\.excalidraw\\.md$' });
    await service.init();

    expect(service.value('excludePaths')).toEqual(['(^|/)Templates/|\\.excalidraw\\.md$']);
    // Sibling defaults survive the partial save.
    expect(service.value('allowedExtensions')).toBe(DEFAULT_SETTINGS.allowedExtensions);
  });

  it('migrates a blank legacy excludePaths string to the empty-array default', async () => {
    const service = makeService({ excludePaths: '   ' });
    await service.init();

    expect(service.value('excludePaths')).toEqual([]);
  });

  it('keeps an already-array excludePaths value untouched', async () => {
    const service = makeService({ excludePaths: ['Templates', 'Daily/**'] });
    await service.init();

    expect(service.value('excludePaths')).toEqual(['Templates', 'Daily/**']);
    expect(service.value('allowedExtensions')).toBe(DEFAULT_SETTINGS.allowedExtensions);
  });

  it('loads a clone of the defaults when there is no saved data', async () => {
    const service = makeService(null);
    await service.init();

    expect(service.values()).toEqual(DEFAULT_SETTINGS);
    // Nested groups must be fresh objects, not aliases of the shared defaults.
    expect(service.values().show).not.toBe(DEFAULT_SETTINGS.show);
    expect(service.values().gutter).not.toBe(DEFAULT_SETTINGS.gutter);
    expect(service.values().line).not.toBe(DEFAULT_SETTINGS.line);
  });
});

describe('SettingsService update', () => {
  it('never mutates DEFAULT_SETTINGS', async () => {
    const before = JSON.stringify(DEFAULT_SETTINGS);
    const service = makeService(null);
    await service.init();

    service.update('show.changed', false);
    service.update('line.width', 99);
    service.update('gutter.changed', 'ZZ');

    expect(service.value('show.changed')).toBe(false);
    expect(service.value('line.width')).toBe(99);
    expect(service.value('gutter.changed')).toBe('ZZ');

    expect(JSON.stringify(DEFAULT_SETTINGS)).toBe(before);
  });
});
