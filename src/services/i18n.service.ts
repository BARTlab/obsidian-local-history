import { isString } from 'lodash-es';

import { FALLBACK_LANGUAGE, LANGUAGE_STORAGE_KEY, OBSIDIAN_LANGUAGES, PLACEHOLDER_PATTERN } from '@/consts';
import { BUNDLED_CATALOGS } from '@/helpers/i18n.helper';
import type LineChangeTrackerPlugin from '@/main';
import type { Service, TranslationCatalog, TranslationCatalogs, TranslationVars } from '@/types';

export { OBSIDIAN_LANGUAGES } from '@/consts';

/**
 * Service that provides plugin-owned localization. It resolves a user-facing
 * string for a dotted key from the catalog matching Obsidian's selected language
 * (read from localStorage) and falls back to English per key, so a partially
 * translated language never surfaces a raw key in production. Placeholders of the
 * form `{name}` are interpolated from the supplied vars.
 *
 * The bundled catalogs are registered on init from the statically imported
 * `lang/<code>.json` files; the pure resolution logic lives in the
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

    if (active && isString(active[key])) {
      return active[key];
    }

    const fallback: TranslationCatalog | undefined = all[FALLBACK_LANGUAGE];

    if (fallback && isString(fallback[key])) {
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
   * Detects the active language. It prefers Obsidian's `language` localStorage
   * hint, then falls back to the global moment locale (which Obsidian sets to the
   * UI language), and finally to English. The moment fallback matters because the
   * `language` key is only written when the language is explicitly chosen, so an
   * OS-auto-detected language would otherwise be missed and resolve to English.
   *
   * @return {string} The detected language code, or `en` as a fallback
   */
  public static detectLanguage(): string {
    try {
      const stored: string | null = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);

      if (stored && stored.trim() !== '') {
        return stored;
      }
    } catch {
      /**
       * localStorage may be unavailable (e.g. a test runner without a window);
       * fall through to the moment locale.
       */
    }

    try {
      const moment: { locale?: () => string } | undefined =
        (globalThis as { moment?: { locale?: () => string } }).moment;

      const locale: string | undefined = moment?.locale?.();

      if (locale && locale.trim() !== '') {
        return locale;
      }
    } catch {
      /**
       * moment may be absent; fall through to the English default.
       */
    }

    return FALLBACK_LANGUAGE;
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
