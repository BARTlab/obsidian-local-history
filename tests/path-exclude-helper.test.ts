import { describe, expect, it } from '@jest/globals';
import { PathExcludeHelper } from '@/helpers/path-exclude.helper';

/**
 * Tests for the path exclude matcher (D1/C3). They drive the pure
 * PathExcludeHelper directly: the trackable decision in SnapshotsService calls
 * it to keep excluded paths (templates, daily notes, generated files) from ever
 * getting a snapshot. The exclude rule is now a LIST of case-insensitive regular
 * expressions matched against the vault-relative path and OR'd together. The
 * guarantees under test are:
 * - a pattern matches by regexp semantics (anchors, alternation, suffix),
 * - matching is case-insensitive and normalizes path separators,
 * - the entries are OR'd: any matching entry excludes,
 * - an empty list excludes nothing,
 * - an invalid entry excludes nothing and never throws, and
 * - validity is reported separately so the caller can warn the user once.
 */
describe('PathExcludeHelper.isExcluded', () => {
  describe('empty list', () => {
    it('excludes nothing (excludes nothing means tracks everything)', () => {
      expect(PathExcludeHelper.isExcluded('notes/a.md', [])).toBe(false);
      expect(PathExcludeHelper.isExcluded('notes/a.md', ['', '   '])).toBe(false);
    });
  });

  describe('suffix anchor', () => {
    const patterns: string[] = ['\\.excalidraw\\.md$'];

    it('excludes a matching file at the vault root', () => {
      expect(PathExcludeHelper.isExcluded('drawing.excalidraw.md', patterns)).toBe(true);
    });

    it('excludes a matching file at any depth', () => {
      expect(PathExcludeHelper.isExcluded('Drawings/x.excalidraw.md', patterns)).toBe(true);
      expect(PathExcludeHelper.isExcluded('a/b/c/art.excalidraw.md', patterns)).toBe(true);
    });

    it('does not exclude a plain markdown file', () => {
      expect(PathExcludeHelper.isExcluded('notes/plain.md', patterns)).toBe(false);
    });
  });

  describe('folder alternation anchor', () => {
    const patterns: string[] = ['(^|/)Templates/'];

    it('excludes the folder at the vault root', () => {
      expect(PathExcludeHelper.isExcluded('Templates/Daily.md', patterns)).toBe(true);
    });

    it('excludes the folder nested under another folder', () => {
      expect(PathExcludeHelper.isExcluded('areas/Templates/Daily.md', patterns)).toBe(true);
    });

    it('does not exclude a sibling whose name only shares the prefix', () => {
      expect(PathExcludeHelper.isExcluded('Notes/Templates-ideas.md', patterns)).toBe(false);
    });
  });

  describe('OR across entries', () => {
    const patterns: string[] = ['(^|/)Templates/', '\\.excalidraw\\.md$'];

    it('excludes a path matched by the first entry', () => {
      expect(PathExcludeHelper.isExcluded('Templates/note.md', patterns)).toBe(true);
    });

    it('excludes a path matched by the second entry', () => {
      expect(PathExcludeHelper.isExcluded('Drawings/art.excalidraw.md', patterns)).toBe(true);
    });

    it('does not exclude a path matched by neither entry', () => {
      expect(PathExcludeHelper.isExcluded('notes/keep.md', patterns)).toBe(false);
    });

    it('ignores blank entries while honouring the real one', () => {
      expect(PathExcludeHelper.isExcluded('Templates/note.md', ['', '(^|/)Templates/', '  '])).toBe(true);
    });
  });

  describe('case-insensitivity and normalization', () => {
    it('matches regardless of case on either side', () => {
      expect(PathExcludeHelper.isExcluded('TEMPLATES/note.md', ['(^|/)templates/'])).toBe(true);
      expect(PathExcludeHelper.isExcluded('templates/note.md', ['(^|/)Templates/'])).toBe(true);
    });

    it('matches a backslash path against a forward-slash pattern', () => {
      expect(PathExcludeHelper.isExcluded('Templates\\sub\\note.md', ['^Templates/'])).toBe(true);
    });

    it('drops a leading ./ or / before matching the anchored pattern', () => {
      expect(PathExcludeHelper.isExcluded('./Templates/note.md', ['^Templates/'])).toBe(true);
      expect(PathExcludeHelper.isExcluded('/Templates/note.md', ['^Templates/'])).toBe(true);
    });
  });

  describe('case-sensitive mode', () => {
    it('does not match a differently-cased path when caseSensitive is true', () => {
      expect(PathExcludeHelper.isExcluded('TEMPLATES/note.md', ['(^|/)templates/'], true)).toBe(false);
      expect(PathExcludeHelper.isExcluded('templates/note.md', ['(^|/)templates/'], true)).toBe(true);
    });
  });

  describe('invalid entry', () => {
    it('excludes nothing and does not throw on a malformed regexp', () => {
      expect(() => PathExcludeHelper.isExcluded('Templates/note.md', ['[unclosed'])).not.toThrow();
      expect(PathExcludeHelper.isExcluded('Templates/note.md', ['[unclosed'])).toBe(false);
    });

    it('still honours a valid sibling entry when one entry is malformed', () => {
      expect(PathExcludeHelper.isExcluded('Templates/note.md', ['[unclosed', '(^|/)Templates/'])).toBe(true);
    });
  });

  describe('degenerate input', () => {
    it('returns false for an empty path', () => {
      expect(PathExcludeHelper.isExcluded('', ['^Templates/'])).toBe(false);
    });
  });
});

describe('PathExcludeHelper compile cache (T18/C3)', () => {
  type CacheView = { cache: Map<string, RegExp | null> };

  const clearCache = (): void => {
    (PathExcludeHelper as unknown as CacheView).cache.clear();
  };

  /**
   * Each distinct pattern compiles once per distinct raw string + flags, even
   * when the same exclude list is evaluated against many paths. The cache is now
   * a small map (one slot per entry), so a multi-entry list no longer thrashes a
   * single slot: every entry is memoized across calls. We assert by spying on
   * `RegExp` via a temporary subclass.
   */
  it('compiles each entry only once across many checks', () => {
    const originalRegExp: typeof RegExp = globalThis.RegExp;
    let constructed: number = 0;

    class CountingRegExp extends originalRegExp {
      public constructor(source: string | RegExp, flags?: string) {
        super(source as string, flags);
        constructed += 1;
      }
    }

    (globalThis as { RegExp: typeof RegExp }).RegExp = CountingRegExp as unknown as typeof RegExp;
    clearCache();

    try {
      const patterns: string[] = ['(^|/)Templates/', '\\.excalidraw\\.md$'];
      const before: number = constructed;

      for (let i: number = 0; i < 50; i += 1) {
        PathExcludeHelper.isExcluded(`notes/${i}.md`, patterns);
        PathExcludeHelper.isExcluded(`Templates/${i}.md`, patterns);
      }

      // Two distinct entries -> two compiles, regardless of how many paths or
      // how many times the list is evaluated.
      expect(constructed - before).toBe(2);
    } finally {
      (globalThis as { RegExp: typeof RegExp }).RegExp = originalRegExp;
      clearCache();
    }
  });

  it('recompiles when an entry changes but reuses unchanged entries', () => {
    const originalRegExp: typeof RegExp = globalThis.RegExp;
    let constructed: number = 0;

    class CountingRegExp extends originalRegExp {
      public constructor(source: string | RegExp, flags?: string) {
        super(source as string, flags);
        constructed += 1;
      }
    }

    (globalThis as { RegExp: typeof RegExp }).RegExp = CountingRegExp as unknown as typeof RegExp;
    clearCache();

    try {
      PathExcludeHelper.isExcluded('Templates/a.md', ['^Templates/']);
      PathExcludeHelper.isExcluded('Templates/a.md', ['^Templates/']);
      PathExcludeHelper.isExcluded('Drafts/a.md', ['^Drafts/']);
      PathExcludeHelper.isExcluded('Drafts/a.md', ['^Drafts/']);
      // Two distinct patterns -> two compiles, even with extra repeats.
      expect(constructed).toBe(2);
    } finally {
      (globalThis as { RegExp: typeof RegExp }).RegExp = originalRegExp;
      clearCache();
    }
  });

  it('compiles the same pattern twice for distinct case flags', () => {
    const originalRegExp: typeof RegExp = globalThis.RegExp;
    let constructed: number = 0;

    class CountingRegExp extends originalRegExp {
      public constructor(source: string | RegExp, flags?: string) {
        super(source as string, flags);
        constructed += 1;
      }
    }

    (globalThis as { RegExp: typeof RegExp }).RegExp = CountingRegExp as unknown as typeof RegExp;
    clearCache();

    try {
      PathExcludeHelper.isExcluded('Templates/a.md', ['^Templates/'], false);
      PathExcludeHelper.isExcluded('Templates/a.md', ['^Templates/'], true);
      // Same pattern string, different flags -> two distinct cache keys.
      expect(constructed).toBe(2);
    } finally {
      (globalThis as { RegExp: typeof RegExp }).RegExp = originalRegExp;
      clearCache();
    }
  });

  it('skips matching on pathologically long paths (ReDoS length guard)', () => {
    // (a+)+$ is a textbook catastrophic-backtracking pattern. A multi-KiB
    // mostly-`a` path would otherwise pin the regex engine; the guard makes
    // the call return false fast instead of running the match.
    const longPath: string = `${'a'.repeat(8000)}b`;
    const started: number = Date.now();
    const result: boolean = PathExcludeHelper.isExcluded(longPath, ['(a+)+$']);
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
