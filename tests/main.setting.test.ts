/** @vitest-environment jsdom */

import 'reflect-metadata';
import { beforeAll, beforeEach, describe, expect, it, vi, type Mock, type MockInstance } from 'vitest';

import { DEFAULT_SETTINGS } from '@/consts';
import type LineChangeTrackerPlugin from '@/main';
import { TOKENS } from '@/services/tokens';
import { MainSetting } from '@/settings/main.setting';
import type { App } from 'obsidian';
import * as obsidian from 'obsidian';

import { makeInjectHost } from './helpers/builders';
import { installJsdomDomPolyfill } from './helpers/jsdom-dom';
import { type ButtonComponent, SettingGroup, TextComponent } from './stubs/obsidian';

/**
 * Behavior suite for {@link MainSetting}, the plugin's settings tab. It drives a
 * REAL tab instance under jsdom over a container-shaped plugin double, so the
 * assertions pin the tab's own section wiring and the irreversible purge gate -
 * the fixed section order, the purge-button assignment, its disabled-state
 * gating on the exclude-pattern list, and the confirm-gated purge routing -
 * rather than a mock's behavior. The obsidian stub's `Setting` builders fire
 * their component callbacks so the tab body runs; without that the purge button
 * would never be assigned and the tab body would never execute.
 */
describe('MainSetting', () => {
  /** Section headings the tab builds, in the fixed order `display()` renders them. */
  const SECTION_HEADINGS: string[] = [
    'setting.general-heading',
    'setting.exclude-paths.name',
    'setting.snapshots-heading',
    'setting.show-heading',
    'setting.marker-intensity-heading',
    'setting.line-heading',
    'setting.gutter-heading.name',
    'setting.cleanup-heading',
  ];

  let patterns: string[];
  let settings: { value: Mock; update: Mock };
  let snapshots: { purgeExcluded: Mock };
  let modals: { confirm: Mock };

  /** The tab's protected purge-gating surface, reached for assertions. */
  interface TabInternals {
    purgeButton?: ButtonComponent;
    updatePurgeButtonState(): void;
  }

  const internalsOf = (tab: MainSetting): TabInternals => tab as unknown as TabInternals;

  /**
   * Builds the settings-service double `display()` reads. Only `excludePaths`
   * needs a real (mutable) value - it gates the purge button and feeds the
   * exclude-patterns editor; every other key flows into an inert component
   * setter that ignores it, so `undefined` is enough.
   */
  const makeSettings = (): { value: Mock; update: Mock } => ({
    value: vi.fn((key: string): unknown => (key === 'excludePaths' ? patterns : undefined)),
    update: vi.fn(),
  });

  /** Constructs a real tab over a `makeInjectHost` plugin double and runs `display()`. */
  const mountTab = (): MainSetting => {
    const services: Map<unknown, unknown> = new Map<unknown, unknown>([
      [TOKENS.settings, settings],
      [TOKENS.snapshots, snapshots],
      [TOKENS.modals, modals],
    ]);

    const plugin: LineChangeTrackerPlugin = {
      ...makeInjectHost((token: unknown): unknown => services.get(token)),
      t: (key: string): string => key,
    } as unknown as LineChangeTrackerPlugin;

    const tab: MainSetting = new MainSetting({} as App, plugin);

    tab.display();

    return tab;
  };

  /**
   * Spies on the obsidian Notice constructor with an inert implementation, so
   * `new Notice(...)` is recorded without standing up a real toast (spying on an
   * ES6 class without a mock implementation throws on `new`).
   */
  const spyNotice = (): MockInstance<typeof obsidian.Notice> =>
    vi.spyOn(obsidian, 'Notice').mockImplementation(
      (function(this: unknown): void {
        // Inert: record the construction only.
      }) as unknown as (message?: string | DocumentFragment) => obsidian.Notice,
    );

  beforeAll((): void => {
    installJsdomDomPolyfill();
  });

  beforeEach((): void => {
    patterns = [];
    settings = makeSettings();
    snapshots = { purgeExcluded: vi.fn().mockReturnValue(0) };
    modals = { confirm: vi.fn().mockResolvedValue(true) };
    SettingGroup.instances.length = 0;
    TextComponent.instances.length = 0;
  });

  it('builds every section group in the documented order and assigns the destructive purge button', () => {
    const tab: MainSetting = mountTab();
    const purgeButton: ButtonComponent | undefined = internalsOf(tab).purgeButton;

    expect(SettingGroup.instances.map((group: SettingGroup): string | undefined => group.heading)).toEqual(
      SECTION_HEADINGS,
    );
    expect(purgeButton).toBeDefined();
    expect(purgeButton?.buttonText).toBe('setting.purge-excluded.name');
    expect(purgeButton?.destructive).toBe(true);
  });

  it('disables the purge button while no usable exclude pattern is configured and enables it once one is', () => {
    const internals: TabInternals = internalsOf(mountTab());

    // No patterns on the initial render: the purge would match nothing.
    expect(internals.purgeButton?.disabled).toBe(true);

    // A real pattern enables the button in place.
    patterns = ['Templates'];
    internals.updatePurgeButtonState();
    expect(internals.purgeButton?.disabled).toBe(false);

    // A blank-only entry is not a usable pattern, so the gate closes again.
    patterns = ['   '];
    internals.updatePurgeButtonState();
    expect(internals.purgeButton?.disabled).toBe(true);
  });

  it('does not purge when the confirmation dialog is declined', async () => {
    modals.confirm.mockResolvedValue(false);

    const notice: MockInstance<typeof obsidian.Notice> = spyNotice();
    const tab: MainSetting = mountTab();

    await internalsOf(tab).purgeButton?.clickHandler?.();

    expect(modals.confirm).toHaveBeenCalledTimes(1);
    expect(snapshots.purgeExcluded).not.toHaveBeenCalled();
    expect(notice).not.toHaveBeenCalled();

    notice.mockRestore();
  });

  it('routes a confirmed purge to purgeExcluded and reports the no-match notice when nothing matched', async () => {
    snapshots.purgeExcluded.mockReturnValue(0);

    const notice: MockInstance<typeof obsidian.Notice> = spyNotice();
    const tab: MainSetting = mountTab();

    await internalsOf(tab).purgeButton?.clickHandler?.();

    expect(snapshots.purgeExcluded).toHaveBeenCalledTimes(1);
    expect(notice).toHaveBeenCalledWith('notice.purge-excluded.no-match');

    notice.mockRestore();
  });

  it('reports the purged-count notice, not the no-match one, when a confirmed purge removed history', async () => {
    snapshots.purgeExcluded.mockReturnValue(3);

    const notice: MockInstance<typeof obsidian.Notice> = spyNotice();
    const tab: MainSetting = mountTab();

    await internalsOf(tab).purgeButton?.clickHandler?.();

    expect(snapshots.purgeExcluded).toHaveBeenCalledTimes(1);
    expect(notice).toHaveBeenCalledWith('notice.purge-excluded');

    notice.mockRestore();
  });

  /** The number-constrained rows the tab builds: the snapshot thresholds and the retention caps. */
  const numberInputs = (): TextComponent[] =>
    TextComponent.instances.filter((text: TextComponent): boolean =>
      text.inputEl.classList.contains('lct-input-number'),
    );

  /** The gutter-symbol rows the tab builds, one per change type. */
  const gutterInputs = (): TextComponent[] =>
    TextComponent.instances.filter((text: TextComponent): boolean =>
      text.inputEl.classList.contains('lct-gutter-char-input'),
    );

  it('constrains every snapshot and retention numeric row to a bounded native number input', () => {
    mountTab();

    const inputs: TextComponent[] = numberInputs();

    // Four snapshot thresholds plus four retention caps all pass through constrainNumberInput.
    expect(inputs).toHaveLength(8);

    inputs.forEach((text: TextComponent): void => {
      expect(text.inputEl.type).toBe('number');
      expect(text.inputEl.min).toBe('0');
      expect(text.inputEl.step).toBe('1');
    });
  });

  it('constrains every gutter-symbol row to a single character with the gutter width class', () => {
    mountTab();

    const inputs: TextComponent[] = gutterInputs();

    // One symbol input per change type: changed, added, restored, removed.
    expect(inputs).toHaveLength(4);

    inputs.forEach((text: TextComponent): void => {
      expect(text.inputEl.maxLength).toBe(1);
      expect(text.inputEl.classList.contains('lct-gutter-char-input')).toBe(true);
    });
  });

  it('routes a numeric-row edit through toCount, clamping negatives to zero and passing a valid count through', () => {
    mountTab();

    // The first numeric row display() builds is the snapshot edit threshold, whose
    // change handler routes the raw string straight through toCount to the store.
    const editThreshold: TextComponent = numberInputs()[0];

    editThreshold.changeHandler?.('-5');
    expect(settings.update).toHaveBeenLastCalledWith('snapshots.editThreshold', 0);

    editThreshold.changeHandler?.('42');
    expect(settings.update).toHaveBeenLastCalledWith('snapshots.editThreshold', 42);
  });

  it('falls a numeric-row edit back to the row default when the value is blank or non-numeric', () => {
    mountTab();

    const editThreshold: TextComponent = numberInputs()[0];
    const fallback: number = DEFAULT_SETTINGS.snapshots.editThreshold;

    editThreshold.changeHandler?.('');
    expect(settings.update).toHaveBeenLastCalledWith('snapshots.editThreshold', fallback);

    editThreshold.changeHandler?.('not-a-number');
    expect(settings.update).toHaveBeenLastCalledWith('snapshots.editThreshold', fallback);
  });

  it('feeds the allowed-extensions text row through verbatim and back to the default when cleared', () => {
    mountTab();

    // The lone unconstrained text row (neither numeric nor gutter class) is the allowed-extensions field.
    const text: TextComponent | undefined = TextComponent.instances.find((candidate: TextComponent): boolean =>
      !candidate.inputEl.classList.contains('lct-input-number')
      && !candidate.inputEl.classList.contains('lct-gutter-char-input'),
    );

    text?.changeHandler?.('md,txt');
    expect(settings.update).toHaveBeenLastCalledWith('allowedExtensions', 'md,txt');

    text?.changeHandler?.('');
    expect(settings.update).toHaveBeenLastCalledWith('allowedExtensions', DEFAULT_SETTINGS.allowedExtensions);
  });
});
