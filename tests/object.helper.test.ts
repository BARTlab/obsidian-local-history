import { afterEach, describe, expect, it } from 'vitest';
import { merge, set } from '@/helpers/object.helper';

/**
 * Tests for the local lodash replacements, focused on the prototype-pollution
 * guard in the recursive `merge` and `set`. SettingsService feeds
 * `merge({}, DEFAULT_SETTINGS, saved)` where `saved` is the plugin's `data.json`
 * (which can arrive from a shared or synced vault), so a `__proto__` /
 * `constructor` key in that payload must never reach `Object.prototype`. The
 * malicious inputs are built with `JSON.parse` on purpose: an object literal
 * `{ __proto__: ... }` sets the prototype instead of creating an own key, while
 * `JSON.parse` produces a real own `__proto__` property that `Object.keys`
 * enumerates.
 */
describe('object.helper prototype-pollution guard', () => {
  // Fail loud if a regression ever pollutes the shared prototype, and stop it
  // from cascading into unrelated suites.
  afterEach(() => {
    delete (Object.prototype as Record<string, unknown>).polluted;
  });

  it('merge does not pollute Object.prototype via __proto__', () => {
    const malicious: Record<string, unknown> = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>;

    merge({}, malicious);

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('merge does not pollute via constructor.prototype', () => {
    const malicious: Record<string, unknown> =
      JSON.parse('{"constructor":{"prototype":{"polluted":true}}}') as Record<string, unknown>;

    merge({}, malicious);

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('set refuses a prototype-polluting path and leaves the target untouched', () => {
    const target: Record<string, unknown> = {};

    set(target, '__proto__.polluted', true);

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(target).toEqual({});
  });

  it('merge still deep-merges legitimate nested objects', () => {
    expect(merge({ a: { x: 1 } }, { a: { y: 2 } })).toEqual({ a: { x: 1, y: 2 } });
  });

  it('set still writes a nested path', () => {
    expect(set({}, 'a.b.c', 1)).toEqual({ a: { b: { c: 1 } } });
  });
});
