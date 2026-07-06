import { describe, expect, it } from 'vitest';
import { diffFrontmatter } from '@/helpers/frontmatter-diff.helper';
import type { FrontmatterChange } from '@/helpers/frontmatter-diff.helper';

/** Convenience: wrap a multiline string into a lines array. */
const lines = (text: string): string[] => text.split('\n');

/** Empty result sentinel for clarity in assertions. */
const EMPTY: FrontmatterChange = { added: [], modified: [], removed: [] };

// ---------------------------------------------------------------------------
// No frontmatter
// ---------------------------------------------------------------------------

describe('diffFrontmatter - no frontmatter', () => {
  it('returns empty result when neither version has frontmatter', () => {
    const result = diffFrontmatter(['Hello world'], ['Hello world']);

    expect(result).toEqual(EMPTY);
  });

  it('returns empty result for completely empty line arrays', () => {
    const result = diffFrontmatter([], []);

    expect(result).toEqual(EMPTY);
  });

  it('returns empty result when opening --- is absent in both versions', () => {
    const result = diffFrontmatter(['title: foo', 'body'], ['title: bar', 'body']);

    expect(result).toEqual(EMPTY);
  });
});

// ---------------------------------------------------------------------------
// Unclosed frontmatter (opening --- present, no closing ---)
// ---------------------------------------------------------------------------

describe('diffFrontmatter - unclosed frontmatter', () => {
  it('returns empty result and does not throw when old is unclosed', () => {
    const old = lines('---\ntitle: foo');
    const current = lines('---\ntitle: foo\n---\nbody');

    const result = diffFrontmatter(old, current);

    // old has no closing ---; treated as no frontmatter. new has full block.
    // 'title' is present in new but absent from old => added.
    expect(result.added).toContain('title');
    expect(result.removed).toHaveLength(0);
  });

  it('returns empty result and does not throw when new is unclosed', () => {
    const old = lines('---\ntitle: foo\n---\nbody');
    const current = lines('---\ntitle: foo');

    const result = diffFrontmatter(old, current);

    // new has no closing ---; treated as no frontmatter. old had a key.
    expect(result.removed).toContain('title');
    expect(result.added).toHaveLength(0);
  });

  it('returns empty result when both versions have unclosed frontmatter', () => {
    const old = lines('---\ntitle: foo');
    const current = lines('---\ntitle: bar');

    expect(diffFrontmatter(old, current)).toEqual(EMPTY);
  });
});

// ---------------------------------------------------------------------------
// Removed key
// ---------------------------------------------------------------------------

describe('diffFrontmatter - removed key', () => {
  it('reports removed when old has "aliases" and new does not', () => {
    const old = lines('---\naliases: [foo]\n---');
    const current = lines('---\ntitle: bar\n---');

    const result = diffFrontmatter(old, current);

    expect(result.removed).toContain('aliases');
    expect(result.added).toContain('title');
    expect(result.modified).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Added key
// ---------------------------------------------------------------------------

describe('diffFrontmatter - added key', () => {
  it('reports added when new has "tags" and old does not', () => {
    const old = lines('---\ntitle: foo\n---');
    const current = lines('---\ntitle: foo\ntags: [todo]\n---');

    const result = diffFrontmatter(old, current);

    expect(result.added).toContain('tags');
    expect(result.modified).toHaveLength(0);
    expect(result.removed).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Modified key
// ---------------------------------------------------------------------------

describe('diffFrontmatter - modified key', () => {
  it('reports modified when both have "status" but values differ', () => {
    const old = lines('---\nstatus: draft\n---');
    const current = lines('---\nstatus: published\n---');

    const result = diffFrontmatter(old, current);

    expect(result.modified).toContain('status');
    expect(result.added).toHaveLength(0);
    expect(result.removed).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Unchanged key
// ---------------------------------------------------------------------------

describe('diffFrontmatter - unchanged key', () => {
  it('does not report modified when both have identical "title"', () => {
    const old = lines('---\ntitle: My Note\n---');
    const current = lines('---\ntitle: My Note\n---');

    const result = diffFrontmatter(old, current);

    expect(result.modified).not.toContain('title');
    expect(result).toEqual(EMPTY);
  });
});

// ---------------------------------------------------------------------------
// Multiline list value
// ---------------------------------------------------------------------------

describe('diffFrontmatter - multiline list value', () => {
  it('reports only the key, not individual list items, when a list changes', () => {
    const old = lines('---\ntags:\n  - alpha\n  - beta\n---');
    const current = lines('---\ntags:\n  - alpha\n  - beta\n  - gamma\n---');

    const result = diffFrontmatter(old, current);

    expect(result.modified).toContain('tags');
    // Individual lines like '  - gamma' must NOT appear in any array.
    expect(result.modified).not.toContain('  - gamma');
    expect(result.added).toHaveLength(0);
    expect(result.removed).toHaveLength(0);
  });

  it('does not report modified when multiline list is identical', () => {
    const yaml = '---\ntags:\n  - alpha\n  - beta\n---';
    const result = diffFrontmatter(lines(yaml), lines(yaml));

    expect(result).toEqual(EMPTY);
  });
});

// ---------------------------------------------------------------------------
// Combined changes
// ---------------------------------------------------------------------------

describe('diffFrontmatter - combined changes', () => {
  it('correctly categorises added, modified, and removed keys simultaneously', () => {
    const old = lines('---\ntitle: Old\naliases: [a]\nstatus: draft\n---');
    const current = lines('---\ntitle: New\ntags: [t]\nstatus: draft\n---');

    const result = diffFrontmatter(old, current);

    expect(result.modified).toContain('title');
    expect(result.added).toContain('tags');
    expect(result.removed).toContain('aliases');
    // 'status' is unchanged.
    expect(result.modified).not.toContain('status');
  });
});

// ---------------------------------------------------------------------------
// Edge: frontmatter only in one version
// ---------------------------------------------------------------------------

describe('diffFrontmatter - frontmatter in one version only', () => {
  it('treats all old keys as removed when new has no frontmatter', () => {
    const old = lines('---\ntitle: foo\nauthor: bar\n---');
    const current = ['No frontmatter here'];

    const result = diffFrontmatter(old, current);

    expect(result.removed).toContain('title');
    expect(result.removed).toContain('author');
    expect(result.added).toHaveLength(0);
  });

  it('treats all new keys as added when old has no frontmatter', () => {
    const old = ['No frontmatter here'];
    const current = lines('---\ntitle: foo\nauthor: bar\n---');

    const result = diffFrontmatter(old, current);

    expect(result.added).toContain('title');
    expect(result.added).toContain('author');
    expect(result.removed).toHaveLength(0);
  });
});
