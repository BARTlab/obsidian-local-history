import { describe, expect, it } from '@jest/globals';
import en from '../lang/en.json';
import ru from '../lang/ru.json';

/**
 * Guards the shipped translation catalogs (T12). Every language must expose the
 * exact same set of keys as English (the universal fallback) and must not carry
 * an empty value, so no UI surface silently degrades to the English fallback or
 * to a blank string in a translated language. English is the reference set
 * because it is the catalog every key is guaranteed to exist in.
 */

type Catalog = Record<string, string>;

const en_catalog: Catalog = en as Catalog;
const ru_catalog: Catalog = ru as Catalog;

const catalogs: Record<string, Catalog> = { ru: ru_catalog };

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
