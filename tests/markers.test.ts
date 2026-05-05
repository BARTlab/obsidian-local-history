import 'reflect-metadata';
import { describe, expect, it, jest } from '@jest/globals';

// DotMarker and RemovedMarker extend GutterMarker from @codemirror/view. Stub
// the view layer with a trivial base class so the markers load under the node
// test environment without the DOM. toDOM is not exercised here (it needs a
// document); the test checks the settings-derived elementClass and char state.
jest.mock('@codemirror/view', () => ({
  GutterMarker: class {},
}));

import { ChangeType, DEFAULT_SETTINGS } from '@/consts';
import { DotMarker } from '@/markers/char.marker';
import { RemovedMarker } from '@/markers/removed.marker';

type AnyRecord = Record<string, unknown>;

/**
 * Builds a fake plugin whose container resolves SettingsService to a stub that
 * reads dotted paths off DEFAULT_SETTINGS, mirroring SettingsService.value.
 */
const makePlugin = (): unknown => {
  const settings = {
    value: (path: string): unknown =>
      path.split('.').reduce<unknown>((acc, part) => (acc as AnyRecord)?.[part], DEFAULT_SETTINGS),
  };

  return { get: (name: string): unknown => (name === 'SettingsService' ? settings : undefined) };
};

describe('DotMarker init-order safety', () => {
  it('derives elementClass and char from settings without depending on field-init order', () => {
    const marker = new DotMarker(ChangeType.changed, makePlugin() as never);

    expect(marker.elementClass).toBe('lct-dot lct-changed');
    expect(marker.getChangeType()).toBe(ChangeType.changed);
    expect(marker.getChar()).toBe(DEFAULT_SETTINGS.gutter.changed);
  });

  it('uses the per-change gutter character for added and restored markers', () => {
    const added = new DotMarker(ChangeType.added, makePlugin() as never);
    const restored = new DotMarker(ChangeType.restored, makePlugin() as never);

    expect(added.elementClass).toBe('lct-dot lct-added');
    expect(added.getChar()).toBe(DEFAULT_SETTINGS.gutter.added);
    expect(restored.elementClass).toBe('lct-dot lct-restored');
    expect(restored.getChar()).toBe(DEFAULT_SETTINGS.gutter.restored);
  });

  it('treats markers with the same change type and char as equal', () => {
    const a = new DotMarker(ChangeType.changed, makePlugin() as never);
    const b = new DotMarker(ChangeType.changed, makePlugin() as never);
    const c = new DotMarker(ChangeType.added, makePlugin() as never);

    expect(a.eq(b)).toBe(true);
    expect(a.eq(c)).toBe(false);
  });
});

describe('RemovedMarker init-order safety', () => {
  it('exposes a static removed elementClass independent of injection', () => {
    const marker = new RemovedMarker(makePlugin() as never);

    expect(marker.elementClass).toBe('lct-dot lct-removed');
  });
});
