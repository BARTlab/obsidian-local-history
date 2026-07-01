import { describe, expect, it } from '@jest/globals';
import * as VersionSearchHelper from '@/helpers/version-search.helper';
import type { SearchableVersion } from '@/types';

/**
 * Tests for the version-rail content search. They drive
 * VersionSearchHelper.match directly on a list of {id, content} versions and a
 * query, which is the pure unit the history modal's left rail delegates to when
 * filtering the timeline. The guarantees under test are:
 * - an empty or whitespace-only query keeps every version (clearing restores
 *   the full list),
 * - a non-empty query keeps only versions whose content contains it,
 * - matching is case-insensitive, and
 * - a query matching nothing yields an empty set (the modal then shows its
 *   no-results hint while leaving the original anchor and the selection intact).
 */
describe('VersionSearchHelper.match', () => {
  const versions: SearchableVersion[] = [
    { id: 'v1', content: 'The quick brown fox' },
    { id: 'v2', content: 'jumps over the lazy DOG' },
    { id: 'v3', content: 'completely unrelated text' },
  ];

  it('returns every version id for an empty query', () => {
    expect(VersionSearchHelper.match(versions, '')).toEqual(new Set(['v1', 'v2', 'v3']));
  });

  it('returns every version id for a whitespace-only query', () => {
    expect(VersionSearchHelper.match(versions, '   ')).toEqual(new Set(['v1', 'v2', 'v3']));
  });

  it('keeps only versions whose content contains the query', () => {
    expect(VersionSearchHelper.match(versions, 'fox')).toEqual(new Set(['v1']));
  });

  it('matches case-insensitively', () => {
    // Lower-case query against upper-case content and vice versa.
    expect(VersionSearchHelper.match(versions, 'dog')).toEqual(new Set(['v2']));
    expect(VersionSearchHelper.match(versions, 'QUICK')).toEqual(new Set(['v1']));
  });

  it('can match more than one version', () => {
    // "the" appears in v1 ("The") and v2 ("the").
    expect(VersionSearchHelper.match(versions, 'the')).toEqual(new Set(['v1', 'v2']));
  });

  it('returns an empty set when nothing matches', () => {
    expect(VersionSearchHelper.match(versions, 'zzz-no-match')).toEqual(new Set());
  });

  it('trims surrounding whitespace before matching', () => {
    expect(VersionSearchHelper.match(versions, '  fox  ')).toEqual(new Set(['v1']));
  });

  it('tolerates an empty version list', () => {
    expect(VersionSearchHelper.match([], 'anything')).toEqual(new Set());
    expect(VersionSearchHelper.match([], '')).toEqual(new Set());
  });

  it('tolerates a nullish version list and query', () => {
    // Defensive: callers should pass real values, but the helper must not throw.
    expect(VersionSearchHelper.match(undefined as unknown as SearchableVersion[], 'x')).toEqual(new Set());
    expect(VersionSearchHelper.match(versions, undefined as unknown as string)).toEqual(new Set(['v1', 'v2', 'v3']));
  });
});
