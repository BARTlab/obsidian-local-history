import type { TranslationCatalogs } from '@/types';
import am from '../lang/am.json';
import ar from '../lang/ar.json';
import be from '../lang/be.json';
import bn from '../lang/bn.json';
import ca from '../lang/ca.json';
import cs from '../lang/cs.json';
import da from '../lang/da.json';
import de from '../lang/de.json';
import en from '../lang/en.json';
import enGB from '../lang/en-GB.json';
import es from '../lang/es.json';
import fa from '../lang/fa.json';
import fi from '../lang/fi.json';
import fr from '../lang/fr.json';
import ga from '../lang/ga.json';
import he from '../lang/he.json';
import hu from '../lang/hu.json';
import id from '../lang/id.json';
import it from '../lang/it.json';
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
 * The catalogs bundled with the plugin, keyed by language code. They are statically
 * imported (not loaded at runtime) so esbuild includes them in the main bundle:
 * esbuild only bundles the `main.ts` import graph, so a dynamic file read would not
 * ship the JSON. This module is the single seam for the language bundle: it is the
 * only place that imports `lang/<code>.json`, and `i18n.service.ts` consumes the
 * aggregated object below. English is the universal fallback every key is
 * guaranteed to exist in (handled by the service). The hyphenated codes (`en-GB`,
 * `pt-BR`, `zh-TW`) are quoted keys because the language code is not a valid
 * identifier.
 */
export const BUNDLED_CATALOGS: TranslationCatalogs = {
  am,
  ar,
  be,
  bn,
  ca,
  cs,
  da,
  de,
  en,
  'en-GB': enGB,
  es,
  fa,
  fi,
  fr,
  ga,
  he,
  hu,
  id,
  it,
  ja,
  ka,
  kh,
  ko,
  lv,
  ms,
  ne,
  nl,
  no,
  pl,
  pt,
  'pt-BR': ptBR,
  ro,
  ru,
  sk,
  sq,
  sr,
  sv,
  th,
  tr,
  uk,
  uz,
  vi,
  zh,
  'zh-TW': zhTW,
};
