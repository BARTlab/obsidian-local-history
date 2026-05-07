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
