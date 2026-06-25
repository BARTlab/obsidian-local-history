/// <reference types="node" />
import { describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Guards the shipped translation catalogs. Every language must expose the
 * exact same set of keys as English (the universal fallback) and must not carry
 * an empty value, so no UI surface silently degrades to the English fallback or
 * to a blank string in a translated language. English is the reference set
 * because it is the catalog every key is guaranteed to exist in.
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

describe('translation catalogs', () => {
  it('en has at least one key', () => {
    expect(Object.keys(en_catalog).length).toBeGreaterThan(0);
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
    });
  }
});
