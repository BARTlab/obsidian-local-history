/** Narrow translator surface: the controller only needs the current-column label. */
export interface DiffHeaderTranslator {
  t(key: string): string;
}
