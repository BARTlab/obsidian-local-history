import type LineChangeTrackerPlugin from '@/main';
import type { Service, TranslationCatalog, TranslationCatalogs, TranslationVars } from '@/types';
import en from '../../lang/en.json';
import ru from '../../lang/ru.json';

/**
 * The catalogs bundled with the plugin, keyed by language code. They are statically
 * imported (not loaded at runtime) so esbuild includes them in the main bundle:
 * esbuild only bundles the `main.ts` import graph, so a dynamic file read would not
 * ship the JSON. English is the universal fallback every key is guaranteed to exist
 * in (see {@link FALLBACK_LANGUAGE}).
 */
const BUNDLED_CATALOGS: TranslationCatalogs = {
  en,
  ru,
};

/**
 * The language code used as the universal fallback. Every key is guaranteed to
 * exist in this catalog, so a missing translation in another language resolves
 * to the English string rather than a raw key.
 */
const FALLBACK_LANGUAGE = 'en';

/**
 * The localStorage key Obsidian writes the selected UI language into. Reading it
 * is the documented community approach to follow Obsidian's own language without
 * a public i18n API (see DECISIONS.md D5).
 */
const LANGUAGE_STORAGE_KEY = 'language';

/**
 * The full set of UI language codes Obsidian ships, taken verbatim from the
 * official obsidian-translations catalog (the values Obsidian writes into the
 * `language` localStorage key). Every code is supported by this plugin: a code
 * with its own bundled catalog resolves to that catalog, and every other code
 * resolves through the English fallback (see {@link FALLBACK_LANGUAGE}), so the
 * plugin never surfaces a raw key or an error for any Obsidian language. New
 * catalogs are added by dropping a `lang/<code>.json` file (see the contributor
 * guide in README.md) and registering it; no change here is required for a code
 * already in this set.
 */
export const OBSIDIAN_LANGUAGES: readonly string[] = [
  'en',
  'af',
  'am',
  'ar',
  'az',
  'be',
  'bg',
  'bn',
  'ca',
  'cs',
  'da',
  'de',
  'dv',
  'el',
  'en-GB',
  'eo',
  'es',
  'eu',
  'fa',
  'fi',
  'fr',
  'ga',
  'gl',
  'he',
  'hi',
  'hr',
  'hu',
  'id',
  'it',
  'ja',
  'ka',
  'kh',
  'kn',
  'ko',
  'ky',
  'la',
  'lt',
  'lv',
  'ml',
  'ms',
  'nan-TW',
  'ne',
  'nl',
  'nn',
  'no',
  'oc',
  'or',
  'pl',
  'pt',
  'pt-BR',
  'ro',
  'ru',
  'sa',
  'si',
  'sk',
  'sl',
  'sq',
  'sr',
  'sv',
  'sw',
  'ta',
  'te',
  'th',
  'tl',
  'tr',
  'tt',
  'uk',
  'ur',
  'uz',
  'vi',
  'zh',
  'zh-TW',
];

/**
 * Matches a `{name}` placeholder inside a translated string. The captured group
 * is the variable name looked up in the interpolation vars.
 */
const PLACEHOLDER_PATTERN = /\{(\w+)\}/g;

/**
 * Service that provides plugin-owned localization. It resolves a user-facing
 * string for a dotted key from the catalog matching Obsidian's selected language
 * (read from localStorage) and falls back to English per key, so a partially
 * translated language never surfaces a raw key in production. Placeholders of the
 * form `{name}` are interpolated from the supplied vars.
 *
 * The bundled en and ru catalogs are registered on init from the statically
 * imported `lang/<code>.json` files; the pure resolution logic lives in the
 * static {@link I18nService.resolve} so it is unit tested directly without an
 * Obsidian window.
 *
 * @implements {Service}
 */
export class I18nService implements Service {
  /**
   * The language-code-keyed catalogs available at runtime. Populated on init from
   * the bundled `lang/<code>.json` files; kept as an injectable map so the
   * resolver stays decoupled from how catalogs are loaded and can be unit tested
   * with fixtures.
   */
  protected catalogs: TranslationCatalogs = {};

  /**
   * The active language code, detected from Obsidian's localStorage on init and
   * defaulting to English when absent or unreadable.
   */
  protected language: string = FALLBACK_LANGUAGE;

  /**
   * Whether to warn about a missing key. True only outside a production build so
   * the warning helps translators in development without spamming end users.
   */
  protected warnOnMissing: boolean = false;

  /**
   * Creates a new instance of I18nService.
   *
   * @param {LineChangeTrackerPlugin} plugin - The plugin instance
   */
  public constructor(
    protected plugin: LineChangeTrackerPlugin,
  ) {
  }

  /**
   * Initializes the service by registering the bundled catalogs and detecting the
   * active language and the dev flag. Registration runs before any `t` call so a
   * key resolves to its translation rather than falling back to the raw key.
   */
  public init(): void {
    this.register(BUNDLED_CATALOGS);
    this.language = I18nService.detectLanguage();
    this.warnOnMissing = I18nService.isDevBuild();
  }

  /**
   * Registers the available translation catalogs. Called once during init with the
   * bundled catalogs; exposed as a method so the loading strategy is separate from
   * resolution and so tests can seed fixtures directly.
   *
   * @param {TranslationCatalogs} catalogs - Map of language code to its catalog
   */
  public register(catalogs: TranslationCatalogs): void {
    this.catalogs = catalogs ?? {};
  }

  /**
   * Reports whether a language code is one Obsidian can set, so the plugin
   * recognizes it as a supported UI language. Every supported code resolves to a
   * catalog: its own when bundled, otherwise the English fallback. Codes outside
   * this set still resolve (through English) but are not part of Obsidian's UI
   * language list.
   *
   * @param {string} language - The language code to check (e.g. `pt-BR`)
   * @return {boolean} True when the code is in Obsidian's UI language set
   */
  public static isSupportedLanguage(language: string): boolean {
    return OBSIDIAN_LANGUAGES.includes(language);
  }

  /**
   * Maps a language code to the catalog language actually used to resolve its
   * strings: the code itself when a catalog is bundled for it, otherwise the
   * English fallback. This makes the "every Obsidian language resolves a catalog
   * or cleanly falls back to English" guarantee explicit and unit-testable
   * without driving a full `t` call. Pure and Obsidian-free.
   *
   * @param {TranslationCatalogs} catalogs - The available catalogs by language
   * @param {string} language - The active language code
   * @return {string} The code whose catalog backs the strings (the input or `en`)
   */
  public static resolveCatalogLanguage(catalogs: TranslationCatalogs, language: string): string {
    const all: TranslationCatalogs = catalogs ?? {};

    return all[language] ? language : FALLBACK_LANGUAGE;
  }

  /**
   * Translates a dotted key to a user-facing string in the active language,
   * falling back to English when the active language lacks the key, and
   * interpolating any `{name}` placeholders from the supplied vars.
   *
   * @param {string} key - The dotted translation key (e.g. `modal.restore`)
   * @param {TranslationVars} [vars] - Values for `{name}` placeholders
   * @return {string} The localized, interpolated string
   */
  public t(key: string, vars?: TranslationVars): string {
    const resolved: string | null = I18nService.resolve(this.catalogs, this.language, key);

    if (resolved === null && this.warnOnMissing) {
      console.warn(`[i18n] missing translation key: ${key}`);
    }

    return I18nService.interpolate(resolved ?? key, vars);
  }

  /**
   * Resolves the raw (un-interpolated) string for a key, trying the active
   * language first and then the English fallback. Returns null when no catalog
   * provides the key, so the caller can log a miss and degrade to the raw key.
   * Pure and Obsidian-free so it is unit tested directly.
   *
   * @param {TranslationCatalogs} catalogs - The available catalogs by language
   * @param {string} language - The active language code
   * @param {string} key - The dotted translation key
   * @return {string | null} The matched string, or null when no catalog has it
   */
  public static resolve(catalogs: TranslationCatalogs, language: string, key: string): string | null {
    const all: TranslationCatalogs = catalogs ?? {};
    const active: TranslationCatalog | undefined = all[language];

    if (active && typeof active[key] === 'string') {
      return active[key];
    }

    const fallback: TranslationCatalog | undefined = all[FALLBACK_LANGUAGE];

    if (fallback && typeof fallback[key] === 'string') {
      return fallback[key];
    }

    return null;
  }

  /**
   * Replaces every `{name}` placeholder in a template with the matching value
   * from vars. An unmatched placeholder is left intact so a missing var is
   * visible rather than silently blanked. Pure so it is unit tested directly.
   *
   * @param {string} template - The string possibly containing `{name}` tokens
   * @param {TranslationVars} [vars] - The values to substitute
   * @return {string} The interpolated string
   */
  public static interpolate(template: string, vars?: TranslationVars): string {
    if (!vars) {
      return template;
    }

    return template.replace(PLACEHOLDER_PATTERN, (match: string, name: string): string => {
      const value: string | number | undefined = vars[name];

      return value === undefined ? match : String(value);
    });
  }

  /**
   * Detects the active language from Obsidian's localStorage, defaulting to
   * English when the value is absent or storage is unavailable (e.g. under a
   * test runner without a window).
   *
   * @return {string} The detected language code, or `en` as a fallback
   */
  public static detectLanguage(): string {
    try {
      const stored: string | null = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);

      return stored && stored.trim() !== '' ? stored : FALLBACK_LANGUAGE;
    } catch {
      return FALLBACK_LANGUAGE;
    }
  }

  /**
   * Reports whether this is a non-production build, used to gate the missing-key
   * warning. Reads `process.env.NODE_ENV` defensively through globalThis because
   * the Obsidian runtime does not guarantee a `process` global and the project
   * does not pull in Node type definitions.
   *
   * @return {boolean} True when not built for production
   */
  public static isDevBuild(): boolean {
    try {
      const proc: { env?: { NODE_ENV?: string } } | undefined =
        (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process;

      return proc?.env?.NODE_ENV !== 'production';
    } catch {
      return false;
    }
  }
}
