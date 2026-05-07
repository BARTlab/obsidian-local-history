import { describe, expect, it } from '@jest/globals';
import { PathExcludeHelper } from '@/helpers/path-exclude.helper';

/**
 * Tests for the path/glob exclude matcher (T5.6). They drive the pure
 * PathExcludeHelper directly: the trackable decision in SnapshotsService calls
 * it to keep excluded paths (templates, daily notes, generated files) from ever
 * getting a snapshot. The guarantees under test are:
 * - a plain pattern excludes a folder and everything under it,
 * - `*` stays within one path segment while `**` crosses folders,
 * - `?` matches exactly one non-slash character,
 * - matching is case-insensitive and normalizes slashes / trailing slashes, and
 * - an empty or all-blank pattern list excludes nothing.
 */
describe('PathExcludeHelper.parse', () => {
  it('splits on commas and newlines, trimming blank entries', () => {
    expect(PathExcludeHelper.parse('Templates, Daily/**\n\n  Attachments  '))
      .toEqual(['templates', 'daily/**', 'attachments']);
  });

  it('normalizes leading ./, leading and trailing slashes, and backslashes', () => {
    expect(PathExcludeHelper.parse('./Templates/, /Daily, a\\b\\'))
      .toEqual(['templates', 'daily', 'a/b']);
  });

  it('returns an empty list for empty or all-blank input', () => {
    expect(PathExcludeHelper.parse('')).toEqual([]);
    expect(PathExcludeHelper.parse('   ')).toEqual([]);
    expect(PathExcludeHelper.parse(',\n , ')).toEqual([]);
  });
});

describe('PathExcludeHelper.isExcluded', () => {
  describe('empty pattern list', () => {
    it('excludes nothing (excludes nothing means tracks everything)', () => {
      expect(PathExcludeHelper.isExcluded('notes/a.md', [])).toBe(false);
      expect(PathExcludeHelper.isExcluded('notes/a.md', [''])).toBe(false);
      expect(PathExcludeHelper.isExcluded('notes/a.md', PathExcludeHelper.parse('')))
        .toBe(false);
    });
  });

  describe('plain folder prefix', () => {
    const patterns: string[] = PathExcludeHelper.parse('Templates');

    it('excludes a file directly inside the folder', () => {
      expect(PathExcludeHelper.isExcluded('Templates/note.md', patterns)).toBe(true);
    });

    it('excludes a file in a nested subfolder', () => {
      expect(PathExcludeHelper.isExcluded('Templates/sub/deep/note.md', patterns)).toBe(true);
    });

    it('excludes the folder path itself', () => {
      expect(PathExcludeHelper.isExcluded('Templates', patterns)).toBe(true);
    });

    it('does not exclude a sibling whose name only shares the prefix', () => {
      // "Templates2" must not be caught by the "Templates" folder rule.
      expect(PathExcludeHelper.isExcluded('Templates2/note.md', patterns)).toBe(false);
      expect(PathExcludeHelper.isExcluded('TemplatesArchive.md', patterns)).toBe(false);
    });

    it('does not exclude an unrelated path', () => {
      expect(PathExcludeHelper.isExcluded('notes/a.md', patterns)).toBe(false);
    });
  });

  describe('single-segment wildcard (*)', () => {
    it('matches any file in one folder but not across folders', () => {
      const patterns: string[] = PathExcludeHelper.parse('Daily/*.md');

      expect(PathExcludeHelper.isExcluded('Daily/2026-05-31.md', patterns)).toBe(true);
      expect(PathExcludeHelper.isExcluded('Daily/note.md', patterns)).toBe(true);
      // A nested file must not match a single-star segment.
      expect(PathExcludeHelper.isExcluded('Daily/sub/note.md', patterns)).toBe(false);
      // A different extension must not match.
      expect(PathExcludeHelper.isExcluded('Daily/note.txt', patterns)).toBe(false);
    });

    it('matches a suffix pattern within a single segment only', () => {
      const patterns: string[] = PathExcludeHelper.parse('*.excalidraw.md');

      expect(PathExcludeHelper.isExcluded('drawing.excalidraw.md', patterns)).toBe(true);
      // A star does not cross a slash, so a nested file is not matched by a
      // root-level single-segment pattern.
      expect(PathExcludeHelper.isExcluded('folder/drawing.excalidraw.md', patterns)).toBe(false);
    });
  });

  describe('cross-folder wildcard (**)', () => {
    it('matches at any depth', () => {
      const patterns: string[] = PathExcludeHelper.parse('Daily/**');

      expect(PathExcludeHelper.isExcluded('Daily/note.md', patterns)).toBe(true);
      expect(PathExcludeHelper.isExcluded('Daily/sub/deep/note.md', patterns)).toBe(true);
    });

    it('matches a suffix anywhere with a leading **', () => {
      const patterns: string[] = PathExcludeHelper.parse('**/*.excalidraw.md');

      expect(PathExcludeHelper.isExcluded('folder/drawing.excalidraw.md', patterns)).toBe(true);
      expect(PathExcludeHelper.isExcluded('a/b/c/drawing.excalidraw.md', patterns)).toBe(true);
      expect(PathExcludeHelper.isExcluded('notes/plain.md', patterns)).toBe(false);
    });
  });

  describe('single-character wildcard (?)', () => {
    it('matches exactly one non-slash character', () => {
      const patterns: string[] = PathExcludeHelper.parse('Daily/202?-note.md');

      expect(PathExcludeHelper.isExcluded('Daily/2026-note.md', patterns)).toBe(true);
      // Two characters where one is expected must not match.
      expect(PathExcludeHelper.isExcluded('Daily/20266-note.md', patterns)).toBe(false);
      // A slash must not be consumed by `?`.
      expect(PathExcludeHelper.isExcluded('Daily/20/6-note.md', patterns)).toBe(false);
    });
  });

  describe('case-insensitivity and normalization', () => {
    it('matches regardless of case on either side', () => {
      const patterns: string[] = PathExcludeHelper.parse('templates');

      expect(PathExcludeHelper.isExcluded('Templates/Note.md', patterns)).toBe(true);
      expect(PathExcludeHelper.isExcluded('TEMPLATES/note.md', patterns)).toBe(true);
    });

    it('matches a path given with backslashes against a forward-slash pattern', () => {
      const patterns: string[] = PathExcludeHelper.parse('Daily/**');

      expect(PathExcludeHelper.isExcluded('Daily\\sub\\note.md', patterns)).toBe(true);
    });

    it('treats a trailing slash on the pattern as the same folder rule', () => {
      const patterns: string[] = PathExcludeHelper.parse('Templates/');

      expect(PathExcludeHelper.isExcluded('Templates/note.md', patterns)).toBe(true);
      expect(PathExcludeHelper.isExcluded('Templates', patterns)).toBe(true);
    });
  });

  describe('multiple patterns', () => {
    it('excludes when any single pattern matches', () => {
      const patterns: string[] = PathExcludeHelper.parse('Templates, Daily/**, *.excalidraw.md');

      expect(PathExcludeHelper.isExcluded('Templates/t.md', patterns)).toBe(true);
      expect(PathExcludeHelper.isExcluded('Daily/sub/n.md', patterns)).toBe(true);
      expect(PathExcludeHelper.isExcluded('art.excalidraw.md', patterns)).toBe(true);
      expect(PathExcludeHelper.isExcluded('notes/keep.md', patterns)).toBe(false);
    });
  });

  describe('degenerate input', () => {
    it('returns false for an empty path', () => {
      expect(PathExcludeHelper.isExcluded('', ['templates'])).toBe(false);
    });
  });
});
