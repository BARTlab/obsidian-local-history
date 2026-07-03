/**
 * @jest-environment jsdom
 */

/**
 * Tests for StylesService, the settings-driven presentation sync.
 *
 * The service writes the marker-geometry custom properties and toggles the
 * `lct-hover-affordance` body class that styles.scss keys the gutter marker
 * hover widening and extended hit zone on. These tests exercise the class
 * gating - the code-observable half of the hover affordance; the CSS widening
 * and hit zone are verified visually, beyond the jsdom boundary - by driving
 * update() / load() / unload() directly.
 *
 * jsdom supplies a real document.body so classList mutations run against an
 * actual element.
 */

import 'reflect-metadata';
import { afterEach, describe, expect, it } from '@jest/globals';
import { StylesService } from '@/services/styles.service';
import { TOKENS } from '@/services/tokens';

type PluginArg = ConstructorParameters<typeof StylesService>[0];

const HOVER_CLASS = 'lct-hover-affordance';

interface SettingOverrides {
  gutterHoverPanel?: boolean;
  lineWidth?: number;
}

/**
 * Builds a StylesService over a fake plugin whose container resolves a settings
 * stub. The stub answers the two paths update() reads: `line.width` for the
 * geometry properties and `gutterHoverPanel` for the hover-affordance class.
 */
const makeService = (overrides: SettingOverrides = {}): StylesService => {
  const { gutterHoverPanel = true, lineWidth = 2 } = overrides;

  const settingsService = {
    value: (path: string): unknown => {
      if (path === 'line.width') {
        return lineWidth;
      }

      if (path === 'gutterHoverPanel') {
        return gutterHoverPanel;
      }

      return undefined;
    },
  };

  const services: Map<unknown, unknown> = new Map<unknown, unknown>([
    [TOKENS.settings, settingsService],
  ]);

  const plugin = {
    get: (key: unknown): unknown => services.get(key),
  };

  return new StylesService(plugin as unknown as PluginArg);
};

afterEach((): void => {
  document.body.classList.remove(HOVER_CLASS);
  document.body.removeAttribute('style');
});

describe('StylesService hover-affordance body class', () => {
  it('adds the gating class when the gutter-hover-panel setting is on', () => {
    makeService({ gutterHoverPanel: true }).update();

    expect(document.body.classList.contains(HOVER_CLASS)).toBe(true);
  });

  it('omits the gating class when the setting is off', () => {
    makeService({ gutterHoverPanel: false }).update();

    expect(document.body.classList.contains(HOVER_CLASS)).toBe(false);
  });

  it('strips a previously-set class when the toggle flips off (live update)', () => {
    // The @_On(settingsUpdate) hook re-runs update() on every settings change,
    // so flipping the toggle off must remove the class, not merely skip adding
    // it. Seed the class to model the feature having been on.
    document.body.classList.add(HOVER_CLASS);

    makeService({ gutterHoverPanel: false }).update();

    expect(document.body.classList.contains(HOVER_CLASS)).toBe(false);
  });

  it('sets the class on load() from the initial setting', () => {
    makeService({ gutterHoverPanel: true }).load();

    expect(document.body.classList.contains(HOVER_CLASS)).toBe(true);
  });

  it('clears the class on unload() so teardown leaves no residue', () => {
    const service = makeService({ gutterHoverPanel: true });
    service.load();

    service.unload();

    expect(document.body.classList.contains(HOVER_CLASS)).toBe(false);
  });
});
