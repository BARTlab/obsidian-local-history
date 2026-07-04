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
import { BarMarker } from '@/markers/bar.marker';
import { DotMarker } from '@/markers/dot.marker';
import { RemovedMarker } from '@/markers/removed.marker';
import { TOKENS } from '@/services/tokens';

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

  return { get: (key: unknown): unknown => (key === TOKENS.settings ? settings : undefined) };
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

describe('BarMarker', () => {
  it('tags the gutter element with the line indicator and the change kind', () => {
    expect(new BarMarker(ChangeType.changed).elementClass).toBe('lct-line lct-changed');
    expect(new BarMarker(ChangeType.added).elementClass).toBe('lct-line lct-added');
    expect(new BarMarker(ChangeType.removed).elementClass).toBe('lct-line lct-removed');
  });

  it('treats markers with the same change kind as equal', () => {
    const a = new BarMarker(ChangeType.changed);
    const b = new BarMarker(ChangeType.changed);
    const c = new BarMarker(ChangeType.added);

    expect(a.eq(b)).toBe(true);
    expect(a.eq(c)).toBe(false);
    expect(a.getChangeType()).toBe(ChangeType.changed);
  });

  it('tags run continuation with join classes', () => {
    expect(new BarMarker(ChangeType.changed, true, true).elementClass)
      .toBe('lct-line lct-changed lct-join-up lct-join-down');
    expect(new BarMarker(ChangeType.changed, false, true).elementClass)
      .toBe('lct-line lct-changed lct-join-down');
    expect(new BarMarker(ChangeType.changed, true, false).elementClass)
      .toBe('lct-line lct-changed lct-join-up');
  });

  it('treats markers with different join flags as not equal', () => {
    const plain = new BarMarker(ChangeType.changed);
    const joined = new BarMarker(ChangeType.changed, false, true);

    expect(plain.eq(joined)).toBe(false);
    expect(joined.eq(new BarMarker(ChangeType.changed, false, true))).toBe(true);
  });
});
