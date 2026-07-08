/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { PLACEHOLDER_PATTERN } from '@/consts';
import { BUNDLED_CATALOGS } from '@/helpers/i18n.helper';

/**
 * Guards the shipped translation catalogs. Every language must expose the
 * exact same set of keys as English (the universal fallback) and must not carry
 * an empty value, so no UI surface silently degrades to the English fallback or
 * to a blank string in a translated language. English is the reference set
 * because it is the catalog every key is guaranteed to exist in.
 *
 * A third guard covers a small allow-list of feature strings (FEATURE_KEYS)
 * that must be genuinely localized, not left byte-equal to the English source.
 * Key parity alone does not catch this: a value equal to en is a valid fallback,
 * so late-added surfaces can ship in English across most catalogs unnoticed.
 *
 * Two more guards close the gaps data parity alone leaves open:
 * - BUNDLED_CATALOGS must register exactly the lang/*.json files. The runtime
 *   bundle is built from static imports in i18n.helper.ts, so a catalog dropped
 *   into lang/ but not imported would pass every on-disk check and silently
 *   miss the shipped plugin.
 * - Every translation must keep the exact placeholder set of its English
 *   source (per PLACEHOLDER_PATTERN, the same regexp interpolation uses), or
 *   the substituted value silently disappears from that language's UI.
 *
 * Catalogs are discovered automatically via fs.readdirSync so any new lang/*.json
 * file is included without a manual test edit.
 */

type Catalog = Record<string, string>;

const LANG_DIR = path.resolve(__dirname, '..', 'lang');

const allFiles = fs.readdirSync(LANG_DIR)
  .filter((f: string) => f.endsWith('.json'))
  .sort();

const en_catalog: Catalog = require(path.join(LANG_DIR, 'en.json')) as Catalog;

/**
 * Every bundled catalog except English, keyed by its Obsidian language code
 * (filename without the .json extension). The map is built dynamically so
 * adding a new lang/*.json file automatically adds it to parity checks.
 */
const catalogs: Record<string, Catalog> = {};

for (const file of allFiles) {
  if (file === 'en.json') continue;
  const lang = file.replace(/\.json$/, '');
  catalogs[lang] = require(path.join(LANG_DIR, file)) as Catalog;
}

/**
 * Feature strings that must be genuinely localized in every non-English catalog,
 * not left on the English fallback. These arrived late (the vault changes panel
 * and the marker-intensity control) and originally shipped in English across
 * every catalog but ru; this guard keeps a new or reset catalog from regressing
 * them back to the fallback. en-GB is exempt: British English is legitimately
 * identical to the en reference for these strings.
 */
const FEATURE_KEYS: string[] = [
  'command.open-vault-changes',
  'setting.marker-intensity-heading',
  'setting.marker-intensity.desc',
  'view.vault-changes.title',
  'view.vault-changes.search-placeholder',
  'view.vault-changes.layout.tree',
  'view.vault-changes.layout.flat',
  'view.vault-changes.deleted-notice',
];

/**
 * The `{name}` placeholder tokens of a catalog string, sorted so two strings
 * compare by set regardless of token order.
 *
 * @param {string} value - The catalog string to scan
 * @return {string[]} The sorted placeholder tokens, e.g. ['{count}', '{name}']
 */
const placeholders = (value: string): string[] =>
  [...value.matchAll(PLACEHOLDER_PATTERN)].map((m: RegExpMatchArray): string => m[0]).sort();

describe('translation catalogs', () => {
  it('en has at least one key', () => {
    expect(Object.keys(en_catalog).length).toBeGreaterThan(0);
  });

  it('registers exactly the lang/*.json files in BUNDLED_CATALOGS', () => {
    const onDisk: string[] = allFiles.map((f: string): string => f.replace(/\.json$/, '')).sort();
    const bundled: string[] = Object.keys(BUNDLED_CATALOGS).sort();

    expect(bundled).toEqual(onDisk);
  });

  it('en has no empty values', () => {
    const empty: string[] = Object.entries(en_catalog)
      .filter(([, value]: [string, string]): boolean => value.trim() === '')
      .map(([key]: [string, string]): string => key);

    expect(empty).toEqual([]);
  });

  for (const [language, catalog] of Object.entries(catalogs)) {
    describe(language, () => {
      it('has exactly the English key set (no missing, no extra)', () => {
        const reference: string[] = Object.keys(en_catalog).sort();
        const actual: string[] = Object.keys(catalog).sort();

        expect(actual).toEqual(reference);
      });

      it('has no empty values', () => {
        const empty: string[] = Object.entries(catalog)
          .filter(([, value]: [string, string]): boolean => value.trim() === '')
          .map(([key]: [string, string]): string => key);

        expect(empty).toEqual([]);
      });

      it('keeps the placeholder set of every English string', () => {
        const drifted: string[] = Object.keys(en_catalog)
          .filter((key: string): boolean =>
            placeholders(en_catalog[key]).join(',') !== placeholders(catalog[key] ?? '').join(','))
          .map((key: string): string =>
            `${key}: en has [${placeholders(en_catalog[key])}], ${language} has [${placeholders(catalog[key] ?? '')}]`);

        expect(drifted).toEqual([]);
      });

      if (language !== 'en-GB') {
        it('localizes the feature keys (no English fallback left)', () => {
          const untranslated: string[] = FEATURE_KEYS
            .filter((key: string): boolean => catalog[key] === en_catalog[key]);

          expect(untranslated).toEqual([]);
        });
      }
    });
  }
});
