import type { SearchableVersion } from '@/types';

/**
 * Pure helper backing the history modal's left-rail content search. Given a
 * query and the list of timeline versions, it returns the ids of the versions
 * whose captured content contains the query (case-insensitive). An empty or
 * whitespace-only query matches every version, so clearing the box restores the
 * full list.
 *
 * The original baseline is intentionally outside this helper's concern: it is a
 * timeline anchor rather than a captured version, so the modal always renders it
 * and only the version entries below it are filtered here.
 *
 * Resolves the ids of the versions visible for a given search query.
 *
 * @param {SearchableVersion[]} versions - The timeline versions to filter
 * @param {string} query - The raw search query (trimmed and lower-cased here)
 * @return {Set<string>} The ids of the matching versions; every version's id
 *   when the query is empty
 */
export function match(versions: SearchableVersion[], query: string): Set<string> {
  const list: SearchableVersion[] = versions ?? [];
  const needle: string = (query ?? '').trim().toLowerCase();

  if (needle === '') {
    return new Set<string>(list.map((version: SearchableVersion): string => version.id));
  }

  return new Set<string>(
    list
      .filter((version: SearchableVersion): boolean => (version.content ?? '').toLowerCase().includes(needle))
      .map((version: SearchableVersion): string => version.id),
  );
}
