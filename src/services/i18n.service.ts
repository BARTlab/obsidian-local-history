import type LineChangeTrackerPlugin from '@/main';
import type { Service, TranslationCatalog, TranslationCatalogs, TranslationVars } from '@/types';

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
 * The catalogs themselves are filled in a later task (T12 ships the en/ru JSON
 * and wires every UI surface through `t`); this task provides the translator,
 * the language detection, and the fallback/interpolation behaviour. The pure
 * resolution logic lives in the static {@link I18nService.resolve} so it is unit
 * tested directly without an Obsidian window.
 *
 * @implements {Service}
 */
export class I18nService implements Service {
  /**
   * The language-code-keyed catalogs available at runtime. Populated from the
   * bundled `lang/<code>.json` files when string extraction lands (T12); kept as
   * an injectable map so the resolver stays decoupled from how catalogs are
   * loaded and can be unit tested with fixtures.
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
   * Initializes the service by detecting the active language and the dev flag.
   * Catalog registration happens here too once the bundled catalogs exist; until
   * then this only resolves the language so `t` can run with an empty registry
   * and fall back gracefully.
   */
  public init(): void {
    this.language = I18nService.detectLanguage();
    this.warnOnMissing = I18nService.isDevBuild();
  }

  /**
   * Registers the available translation catalogs. Called once during setup with
   * the bundled catalogs (T12); exposed as a method so the loading strategy is
   * separate from resolution and so tests can seed fixtures directly.
   *
   * @param {TranslationCatalogs} catalogs - Map of language code to its catalog
   */
  public register(catalogs: TranslationCatalogs): void {
    this.catalogs = catalogs ?? {};
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
