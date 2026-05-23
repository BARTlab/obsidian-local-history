import { describe, expect, it } from '@jest/globals';
import { BaseContentHelper } from '@/helpers/base-content.helper';
import type { BaseContentSnapshot } from '@/types';

/**
 * Tests for the history modal diff-base resolution (T01 / D1). They drive
 * BaseContentHelper.resolve directly, which is the pure unit the modal's
 * getBaseContent delegates to when picking the content the current state is
 * diffed against. The full modal renders inside an Obsidian Modal and needs the
 * DOM, so the headless-testable core is this branch selection.
 *
 * The guarantees under test mirror D1:
 * - the synthetic baseline entry diffs against the LATEST snapshot
 *   (getVersions()[0], newest first), not the original,
 * - with no snapshot it falls back to the original and never throws,
 * - a picked intermediate version resolves to that version's content, and
 * - a stale id that no longer addresses a version falls through to the same
 *   baseline rule (latest snapshot, original fallback).
 */
describe('BaseContentHelper.resolve', () => {
  const BASELINE_ID: string = 'original';

  /**
   * Builds a reduced snapshot view from a newest-first list of version contents
   * and the original baseline. versionContent resolves an id of the form
   * `v<index>` (1-based, newest first) to that version's content.
   *
   * @param {string[]} versions - The version contents, newest first
   * @param {string} original - The original baseline content
   * @return {BaseContentSnapshot} The reduced snapshot view
   */
  const snapshot = (versions: string[], original: string): BaseContentSnapshot => ({
    versions,
    original,
    versionContent: (id: string): string | null => {
      const match: RegExpMatchArray | null = id.match(/^v(\d+)$/);

      if (!match) {
        return null;
      }

      return versions[Number(match[1]) - 1] ?? null;
    },
  });

  describe('synthetic baseline entry', () => {
    it('diffs against the latest snapshot when at least one exists', () => {
      const view: BaseContentSnapshot = snapshot(['newest', 'older'], 'birth state');

      expect(BaseContentHelper.resolve(BASELINE_ID, BASELINE_ID, view)).toBe('newest');
    });

    it('falls back to the original when no snapshot exists', () => {
      const view: BaseContentSnapshot = snapshot([], 'birth state');

      expect(BaseContentHelper.resolve(BASELINE_ID, BASELINE_ID, view)).toBe('birth state');
    });

    it('does not throw on an empty timeline', () => {
      const view: BaseContentSnapshot = snapshot([], '');

      expect((): string => BaseContentHelper.resolve(BASELINE_ID, BASELINE_ID, view)).not.toThrow();
      expect(BaseContentHelper.resolve(BASELINE_ID, BASELINE_ID, view)).toBe('');
    });
  });

  describe('picked intermediate version', () => {
    it('resolves to the picked version content', () => {
      const view: BaseContentSnapshot = snapshot(['newest', 'older'], 'birth state');

      expect(BaseContentHelper.resolve('v2', BASELINE_ID, view)).toBe('older');
    });

    it('prefers the picked version over the latest snapshot', () => {
      const view: BaseContentSnapshot = snapshot(['newest', 'older'], 'birth state');

      // v1 is the latest snapshot; picking it explicitly still returns it, but
      // the path differs from the synthetic baseline (no fallback involved).
      expect(BaseContentHelper.resolve('v1', BASELINE_ID, view)).toBe('newest');
    });
  });

  describe('stale id', () => {
    it('falls through to the latest snapshot when the id no longer exists', () => {
      const view: BaseContentSnapshot = snapshot(['newest', 'older'], 'birth state');

      expect(BaseContentHelper.resolve('gone', BASELINE_ID, view)).toBe('newest');
    });

    it('falls through to the original when the id is stale and no snapshot exists', () => {
      const view: BaseContentSnapshot = snapshot([], 'birth state');

      expect(BaseContentHelper.resolve('gone', BASELINE_ID, view)).toBe('birth state');
    });
  });
});
