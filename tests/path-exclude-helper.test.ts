import { describe, expect, it } from '@jest/globals';
import { PathExcludeHelper } from '@/helpers/path-exclude.helper';

/**
 * Tests for the path exclude matcher (D1). They drive the pure
 * PathExcludeHelper directly: the trackable decision in SnapshotsService calls
 * it to keep excluded paths (templates, daily notes, generated files) from ever
 * getting a snapshot. The exclude rule is a single case-insensitive regular
 * expression matched against the vault-relative path. The guarantees under test
 * are:
 * - a pattern matches by regexp semantics (anchors, alternation, suffix),
 * - matching is case-insensitive and normalizes path separators,
 * - an empty pattern excludes nothing,
 * - an invalid pattern excludes nothing and never throws, and
 * - validity is reported separately so the caller can warn the user once.
 */
describe('PathExcludeHelper.isExcluded', () => {
  describe('empty pattern', () => {
    it('excludes nothing (excludes nothing means tracks everything)', () => {
      expect(PathExcludeHelper.isExcluded('notes/a.md', '')).toBe(false);
      expect(PathExcludeHelper.isExcluded('notes/a.md', '   ')).toBe(false);
    });
  });

  describe('suffix anchor', () => {
    const pattern: string = '\\.excalidraw\\.md$';

    it('excludes a matching file at the vault root', () => {
      expect(PathExcludeHelper.isExcluded('drawing.excalidraw.md', pattern)).toBe(true);
    });

    it('excludes a matching file at any depth', () => {
      expect(PathExcludeHelper.isExcluded('Drawings/x.excalidraw.md', pattern)).toBe(true);
      expect(PathExcludeHelper.isExcluded('a/b/c/art.excalidraw.md', pattern)).toBe(true);
    });

    it('does not exclude a plain markdown file', () => {
      expect(PathExcludeHelper.isExcluded('notes/plain.md', pattern)).toBe(false);
    });
  });

  describe('folder alternation anchor', () => {
    const pattern: string = '(^|/)Templates/';

    it('excludes the folder at the vault root', () => {
      expect(PathExcludeHelper.isExcluded('Templates/Daily.md', pattern)).toBe(true);
    });

    it('excludes the folder nested under another folder', () => {
      expect(PathExcludeHelper.isExcluded('areas/Templates/Daily.md', pattern)).toBe(true);
    });

    it('does not exclude a sibling whose name only shares the prefix', () => {
      expect(PathExcludeHelper.isExcluded('Notes/Templates-ideas.md', pattern)).toBe(false);
    });
  });

  describe('case-insensitivity and normalization', () => {
    it('matches regardless of case on either side', () => {
      expect(PathExcludeHelper.isExcluded('TEMPLATES/note.md', '(^|/)templates/')).toBe(true);
      expect(PathExcludeHelper.isExcluded('templates/note.md', '(^|/)Templates/')).toBe(true);
    });

    it('matches a backslash path against a forward-slash pattern', () => {
      expect(PathExcludeHelper.isExcluded('Templates\\sub\\note.md', '^Templates/')).toBe(true);
    });

    it('drops a leading ./ or / before matching the anchored pattern', () => {
      expect(PathExcludeHelper.isExcluded('./Templates/note.md', '^Templates/')).toBe(true);
      expect(PathExcludeHelper.isExcluded('/Templates/note.md', '^Templates/')).toBe(true);
    });
  });

  describe('invalid pattern', () => {
    it('excludes nothing and does not throw on a malformed regexp', () => {
      expect(() => PathExcludeHelper.isExcluded('Templates/note.md', '[unclosed')).not.toThrow();
      expect(PathExcludeHelper.isExcluded('Templates/note.md', '[unclosed')).toBe(false);
    });
  });

  describe('degenerate input', () => {
    it('returns false for an empty path', () => {
      expect(PathExcludeHelper.isExcluded('', '^Templates/')).toBe(false);
    });
  });
});

describe('PathExcludeHelper compile cache (T18)', () => {
  /**
   * A pattern is compiled once per distinct raw string. The cache is a
   * single-slot key/value, so the same pattern across many `isExcluded` calls
   * goes through `new RegExp` exactly once; changing the pattern invalidates
   * it. We assert by spying on `RegExp` itself via a temporary subclass.
   */
  it('compiles the same pattern only once across many checks', () => {
    const originalRegExp: typeof RegExp = globalThis.RegExp;
    let constructed: number = 0;

    class CountingRegExp extends originalRegExp {
      public constructor(source: string | RegExp, flags?: string) {
        super(source as string, flags);
        constructed += 1;
      }
    }

    (globalThis as { RegExp: typeof RegExp }).RegExp = CountingRegExp as unknown as typeof RegExp;
    // Reset cache so the first call inside this test re-compiles via the spy.
    (PathExcludeHelper as unknown as { cachedPattern: string | null }).cachedPattern = null;
    (PathExcludeHelper as unknown as { cachedRegExp: RegExp | null }).cachedRegExp = null;

    try {
      const pattern: string = '(^|/)Templates/';
      const before: number = constructed;

      for (let i: number = 0; i < 50; i += 1) {
        PathExcludeHelper.isExcluded(`notes/${i}.md`, pattern);
        PathExcludeHelper.isExcluded(`Templates/${i}.md`, pattern);
      }

      expect(constructed - before).toBe(1);
    } finally {
      (globalThis as { RegExp: typeof RegExp }).RegExp = originalRegExp;
      (PathExcludeHelper as unknown as { cachedPattern: string | null }).cachedPattern = null;
      (PathExcludeHelper as unknown as { cachedRegExp: RegExp | null }).cachedRegExp = null;
    }
  });

  it('recompiles when the pattern changes', () => {
    const originalRegExp: typeof RegExp = globalThis.RegExp;
    let constructed: number = 0;

    class CountingRegExp extends originalRegExp {
      public constructor(source: string | RegExp, flags?: string) {
        super(source as string, flags);
        constructed += 1;
      }
    }

    (globalThis as { RegExp: typeof RegExp }).RegExp = CountingRegExp as unknown as typeof RegExp;
    (PathExcludeHelper as unknown as { cachedPattern: string | null }).cachedPattern = null;
    (PathExcludeHelper as unknown as { cachedRegExp: RegExp | null }).cachedRegExp = null;

    try {
      PathExcludeHelper.isExcluded('Templates/a.md', '^Templates/');
      PathExcludeHelper.isExcluded('Templates/a.md', '^Templates/');
      PathExcludeHelper.isExcluded('Drafts/a.md', '^Drafts/');
      PathExcludeHelper.isExcluded('Drafts/a.md', '^Drafts/');
      // Two distinct patterns -> two compiles, even with extra repeats.
      expect(constructed).toBe(2);
    } finally {
      (globalThis as { RegExp: typeof RegExp }).RegExp = originalRegExp;
      (PathExcludeHelper as unknown as { cachedPattern: string | null }).cachedPattern = null;
      (PathExcludeHelper as unknown as { cachedRegExp: RegExp | null }).cachedRegExp = null;
    }
  });

  it('skips matching on pathologically long paths (ReDoS length guard)', () => {
    // (a+)+$ is a textbook catastrophic-backtracking pattern. A multi-KiB
    // mostly-`a` path would otherwise pin the regex engine; the guard makes
    // the call return false fast instead of running the match.
    const evilPattern: string = '(a+)+$';
    const longPath: string = `${'a'.repeat(8000)}b`;
    const started: number = Date.now();
    const result: boolean = PathExcludeHelper.isExcluded(longPath, evilPattern);
    const elapsed: number = Date.now() - started;
    expect(result).toBe(false);
    // Generous upper bound: with the guard this is sub-millisecond; without
    // the guard the same call hangs for seconds.
    expect(elapsed).toBeLessThan(250);
  });
});

describe('PathExcludeHelper.isValid', () => {
  it('treats a blank pattern as valid (it simply excludes nothing)', () => {
    expect(PathExcludeHelper.isValid('')).toBe(true);
    expect(PathExcludeHelper.isValid('   ')).toBe(true);
  });

  it('reports a compilable pattern as valid', () => {
    expect(PathExcludeHelper.isValid('\\.excalidraw\\.md$')).toBe(true);
    expect(PathExcludeHelper.isValid('(^|/)Templates/')).toBe(true);
  });

  it('reports a malformed pattern as invalid', () => {
    expect(PathExcludeHelper.isValid('[unclosed')).toBe(false);
    expect(PathExcludeHelper.isValid('(')).toBe(false);
  });
});
