import { describe, expect, it } from '@jest/globals';
import en from '../lang/en.json';
import am from '../lang/am.json';
import ar from '../lang/ar.json';
import be from '../lang/be.json';
import bn from '../lang/bn.json';
import ca from '../lang/ca.json';
import cs from '../lang/cs.json';
import da from '../lang/da.json';
import de from '../lang/de.json';
import enGB from '../lang/en-GB.json';
import es from '../lang/es.json';
import fa from '../lang/fa.json';
import fi from '../lang/fi.json';
import fr from '../lang/fr.json';
import ga from '../lang/ga.json';
import he from '../lang/he.json';
import hu from '../lang/hu.json';
import id from '../lang/id.json';
import itIT from '../lang/it.json';
import ja from '../lang/ja.json';
import ka from '../lang/ka.json';
import kh from '../lang/kh.json';
import ko from '../lang/ko.json';
import lv from '../lang/lv.json';
import ms from '../lang/ms.json';
import ne from '../lang/ne.json';
import nl from '../lang/nl.json';
import no from '../lang/no.json';
import pl from '../lang/pl.json';
import pt from '../lang/pt.json';
import ptBR from '../lang/pt-BR.json';
import ro from '../lang/ro.json';
import ru from '../lang/ru.json';
import sk from '../lang/sk.json';
import sq from '../lang/sq.json';
import sr from '../lang/sr.json';
import sv from '../lang/sv.json';
import th from '../lang/th.json';
import tr from '../lang/tr.json';
import uk from '../lang/uk.json';
import uz from '../lang/uz.json';
import vi from '../lang/vi.json';
import zh from '../lang/zh.json';
import zhTW from '../lang/zh-TW.json';

/**
 * Guards the shipped translation catalogs (T12). Every language must expose the
 * exact same set of keys as English (the universal fallback) and must not carry
 * an empty value, so no UI surface silently degrades to the English fallback or
 * to a blank string in a translated language. English is the reference set
 * because it is the catalog every key is guaranteed to exist in.
 */

type Catalog = Record<string, string>;

const en_catalog: Catalog = en as Catalog;

/**
 * Every bundled catalog except English, keyed by its Obsidian language code. The
 * key strings here must mirror `BUNDLED_CATALOGS` in i18n.service.ts so the parity
 * guard covers every shipped language.
 */
const catalogs: Record<string, Catalog> = {
  am: am as Catalog,
  ar: ar as Catalog,
  be: be as Catalog,
  bn: bn as Catalog,
  ca: ca as Catalog,
  cs: cs as Catalog,
  da: da as Catalog,
  de: de as Catalog,
  'en-GB': enGB as Catalog,
  es: es as Catalog,
  fa: fa as Catalog,
  fi: fi as Catalog,
  fr: fr as Catalog,
  ga: ga as Catalog,
  he: he as Catalog,
  hu: hu as Catalog,
  id: id as Catalog,
  it: itIT as Catalog,
  ja: ja as Catalog,
  ka: ka as Catalog,
  kh: kh as Catalog,
  ko: ko as Catalog,
  lv: lv as Catalog,
  ms: ms as Catalog,
  ne: ne as Catalog,
  nl: nl as Catalog,
  no: no as Catalog,
  pl: pl as Catalog,
  pt: pt as Catalog,
  'pt-BR': ptBR as Catalog,
  ro: ro as Catalog,
  ru: ru as Catalog,
  sk: sk as Catalog,
  sq: sq as Catalog,
  sr: sr as Catalog,
  sv: sv as Catalog,
  th: th as Catalog,
  tr: tr as Catalog,
  uk: uk as Catalog,
  uz: uz as Catalog,
  vi: vi as Catalog,
  zh: zh as Catalog,
  'zh-TW': zhTW as Catalog,
};

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
