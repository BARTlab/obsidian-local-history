import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nService, OBSIDIAN_LANGUAGES } from '@/services/i18n.service';
import type { TranslationCatalogs } from '@/types';

/**
 * Tests for the localization infrastructure. They cover the pure
 * resolution and interpolation logic directly and the I18nService instance
 * behaviour (active-language lookup, per-key English fallback, the dev-only
 * missing-key warning, and placeholder interpolation) without an Obsidian app.
 * The catalogs are passed as fixtures so the test does not depend on the bundled
 * lang/*.json files, which a later task ships.
 */

type PluginArg = ConstructorParameters<typeof I18nService>[0];

/**
 * Test-only subclass that exposes the protected state so a test can seed
 * catalogs, the active language, and the dev flag without driving init() and an
 * Obsidian window.
 */
class TestI18nService extends I18nService {
  public constructor(plugin: PluginArg) {
    super(plugin);
  }

  public setLanguage(language: string): void {
    this.language = language;
  }

  public setWarnOnMissing(warn: boolean): void {
    this.warnOnMissing = warn;
  }
}

const catalogs: TranslationCatalogs = {
  en: {
    'modal.restore': 'Restore original',
    'modal.versions': 'Versions',
    'notice.captured': 'Captured {count} versions',
  },
  ru: {
    'modal.restore': 'Восстановить оригинал',
    // 'modal.versions' is intentionally absent to exercise the English fallback.
    'notice.captured': 'Захвачено {count} версий',
  },
};

/**
 * Builds a TestI18nService with the fixture catalogs registered. The plugin is a
 * bare stub because the resolver does not touch it (no @Inject getters are read
 * in these paths).
 */
const makeService = (language: string, warnOnMissing = false): TestI18nService => {
  const plugin = {} as unknown as PluginArg;
  const service = new TestI18nService(plugin);

  service.register(catalogs);
  service.setLanguage(language);
  service.setWarnOnMissing(warnOnMissing);

  return service;
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('I18nService.resolve', () => {
  it('returns the active-language string when present', () => {
    expect(I18nService.resolve(catalogs, 'ru', 'modal.restore')).toBe('Восстановить оригинал');
  });

  it('falls back to the English string when the active language lacks the key', () => {
    expect(I18nService.resolve(catalogs, 'ru', 'modal.versions')).toBe('Versions');
  });

  it('returns the English string when the language has no catalog at all', () => {
    expect(I18nService.resolve(catalogs, 'fr', 'modal.restore')).toBe('Restore original');
  });

  it('returns null when no catalog provides the key', () => {
    expect(I18nService.resolve(catalogs, 'ru', 'missing.key')).toBeNull();
  });

  it('tolerates nullish catalogs', () => {
    expect(I18nService.resolve(undefined as unknown as TranslationCatalogs, 'en', 'modal.restore')).toBeNull();
  });
});

describe('I18nService.interpolate', () => {
  it('substitutes a named placeholder', () => {
    expect(I18nService.interpolate('Captured {count} versions', { count: 3 })).toBe('Captured 3 versions');
  });

  it('stringifies numeric values', () => {
    expect(I18nService.interpolate('{n} items', { n: 0 })).toBe('0 items');
  });

  it('leaves an unmatched placeholder intact', () => {
    expect(I18nService.interpolate('Hello {name}', { other: 'x' })).toBe('Hello {name}');
  });

  it('returns the template unchanged when no vars are given', () => {
    expect(I18nService.interpolate('Hello {name}')).toBe('Hello {name}');
  });
});

describe('I18nService.detectLanguage', () => {
  it('returns the stored language when localStorage has one', () => {
    const original = (globalThis as { window?: unknown }).window;

    (globalThis as { window?: unknown }).window = {
      localStorage: { getItem: (): string => 'ru' },
    };

    try {
      expect(I18nService.detectLanguage()).toBe('ru');
    } finally {
      (globalThis as { window?: unknown }).window = original;
    }
  });

  it('falls back to en when localStorage is empty', () => {
    const original = (globalThis as { window?: unknown }).window;

    (globalThis as { window?: unknown }).window = {
      localStorage: { getItem: (): string | null => null },
    };

    try {
      expect(I18nService.detectLanguage()).toBe('en');
    } finally {
      (globalThis as { window?: unknown }).window = original;
    }
  });

  it('falls back to the moment locale when localStorage is empty', () => {
    const originalWindow = (globalThis as { window?: unknown }).window;
    const originalMoment = (globalThis as { moment?: unknown }).moment;

    (globalThis as { window?: unknown }).window = {
      localStorage: { getItem: (): string | null => null },
    };
    (globalThis as { moment?: unknown }).moment = { locale: (): string => 'ru' };

    try {
      expect(I18nService.detectLanguage()).toBe('ru');
    } finally {
      (globalThis as { window?: unknown }).window = originalWindow;
      (globalThis as { moment?: unknown }).moment = originalMoment;
    }
  });

  it('prefers the localStorage language over the moment locale', () => {
    const originalWindow = (globalThis as { window?: unknown }).window;
    const originalMoment = (globalThis as { moment?: unknown }).moment;

    (globalThis as { window?: unknown }).window = {
      localStorage: { getItem: (): string => 'ru' },
    };
    (globalThis as { moment?: unknown }).moment = { locale: (): string => 'de' };

    try {
      expect(I18nService.detectLanguage()).toBe('ru');
    } finally {
      (globalThis as { window?: unknown }).window = originalWindow;
      (globalThis as { moment?: unknown }).moment = originalMoment;
    }
  });

  it('falls back to en when no window is available', () => {
    // Under the node test runner there is no window, so the read throws and the
    // service degrades to English.
    expect(I18nService.detectLanguage()).toBe('en');
  });
});

describe('I18nService.t', () => {
  it('returns the Russian string for a key present in ru', () => {
    expect(makeService('ru').t('modal.restore')).toBe('Восстановить оригинал');
  });

  it('falls back to the English string for a key missing in ru', () => {
    expect(makeService('ru').t('modal.versions')).toBe('Versions');
  });

  it('interpolates placeholders', () => {
    expect(makeService('ru').t('notice.captured', { count: 3 })).toBe('Захвачено 3 версий');
  });

  it('never returns the raw key when the English catalog has it', () => {
    const result = makeService('fr').t('modal.restore');

    expect(result).toBe('Restore original');
    expect(result).not.toBe('modal.restore');
  });

  it('warns about a missing key only when the dev flag is set', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation((): void => undefined);

    makeService('ru', true).t('missing.key');
    expect(warn).toHaveBeenCalledWith('[i18n] missing translation key: missing.key');

    warn.mockClear();
    makeService('ru', false).t('missing.key');
    expect(warn).not.toHaveBeenCalled();
  });

  it('degrades to the raw key when no catalog provides it', () => {
    // Last-resort fallback: a key absent from every catalog returns itself so the
    // UI is never blank.
    expect(makeService('ru').t('missing.key')).toBe('missing.key');
  });
});

describe('I18nService.isSupportedLanguage', () => {
  it('recognizes a plain Obsidian language code', () => {
    expect(I18nService.isSupportedLanguage('ru')).toBe(true);
  });

  it('recognizes a regional Obsidian language code', () => {
    expect(I18nService.isSupportedLanguage('pt-BR')).toBe(true);
    expect(I18nService.isSupportedLanguage('zh-TW')).toBe(true);
  });

  it('rejects a code outside the Obsidian set', () => {
    expect(I18nService.isSupportedLanguage('xx')).toBe(false);
  });

  it('exposes a de-duplicated, non-empty language set', () => {
    expect(OBSIDIAN_LANGUAGES.length).toBeGreaterThan(0);
    expect(new Set(OBSIDIAN_LANGUAGES).size).toBe(OBSIDIAN_LANGUAGES.length);
    expect(OBSIDIAN_LANGUAGES).toContain('en');
  });
});

describe('I18nService.resolveCatalogLanguage', () => {
  it('keeps the language when a catalog is bundled for it', () => {
    expect(I18nService.resolveCatalogLanguage(catalogs, 'ru')).toBe('ru');
  });

  it('falls back to English when no catalog is bundled for the language', () => {
    expect(I18nService.resolveCatalogLanguage(catalogs, 'fr')).toBe('en');
  });

  it('tolerates nullish catalogs', () => {
    expect(
      I18nService.resolveCatalogLanguage(undefined as unknown as TranslationCatalogs, 'ru'),
    ).toBe('en');
  });
});

describe('every Obsidian language resolves without error', () => {
  // Any code Obsidian can set must resolve a catalog (its own when bundled,
  // otherwise the English fallback) and never surface a raw key or throw.
  it.each(OBSIDIAN_LANGUAGES)('resolves a real string for %s', (language: string) => {
    const result = makeService(language).t('modal.restore');

    expect(result).not.toBe('modal.restore');
    expect(result.trim()).not.toBe('');

    // A code without its own bundled catalog resolves through English; ru is the
    // only non-English catalog in the fixtures, so every other code yields the
    // English string.
    if (language !== 'ru') {
      expect(result).toBe('Restore original');
    }
  });
});
