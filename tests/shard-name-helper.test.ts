import { describe, expect, it } from '@jest/globals';
import { ShardNameHelper } from '@/helpers/shard-name.helper';

/**
 * Unit tests for the deterministic shard naming helper (Epic 10, T01). The
 * shard filename is a synchronous hash of a note's vault-relative path; the
 * contract is that it is deterministic, fixed-width, filesystem-safe, and
 * collision free across a realistic corpus of paths.
 */

const SHARD_NAME_PATTERN: RegExp = /^[0-9a-f]{16}\.json$/;

/**
 * Builds a corpus of realistic vault-relative paths: nested folders, spaces,
 * unicode, long names, and near-duplicates that differ by a single character or
 * by ordering, which are the cases most likely to collide under a weak hash.
 */
function buildPaths(): string[] {
  const paths: string[] = [];

  const folders: string[] = ['', 'notes/', 'Projects/2024/', 'журнал/', 'a/b/c/d/'];
  const names: string[] = [
    'index', 'Index', 'index ', ' index', 'index1', 'index2',
    'todo-list', 'todo_list', 'todolist', 'café', 'cafe',
    'a'.repeat(300), 'b'.repeat(300),
  ];

  for (const folder of folders) {
    for (const name of names) {
      paths.push(`${folder}${name}.md`);
    }
  }

  for (let i: number = 0; i < 200; i++) {
    paths.push(`bulk/note-${i}.md`);
    paths.push(`bulk/note-${i}-copy.md`);
  }

  return paths;
}

describe('ShardNameHelper.forPath', () => {
  it('returns a deterministic 16-hex-char .json name for the same path', () => {
    const path: string = 'notes/My Note.md';

    const first: string = ShardNameHelper.forPath(path);
    const second: string = ShardNameHelper.forPath(path);

    expect(first).toBe(second);
    expect(first).toMatch(SHARD_NAME_PATTERN);
    expect(first.length).toBe(ShardNameHelper.DIGEST_LENGTH + '.json'.length);
  });

  it('produces at least 16 hex chars before the extension', () => {
    const digest: string = ShardNameHelper.forPath('x').replace(/\.json$/, '');

    expect(digest.length).toBeGreaterThanOrEqual(16);
    expect(digest).toMatch(/^[0-9a-f]+$/);
  });

  it('gives different names to different realistic paths (no collisions)', () => {
    const paths: string[] = buildPaths();
    const names: Set<string> = new Set<string>();

    for (const path of paths) {
      names.add(ShardNameHelper.forPath(path));
    }

    expect(names.size).toBe(paths.length);
  });

  it('treats near-duplicate paths as distinct', () => {
    const a: string = ShardNameHelper.forPath('notes/index.md');
    const b: string = ShardNameHelper.forPath('notes/Index.md');
    const c: string = ShardNameHelper.forPath('notes/index .md');

    expect(new Set<string>([a, b, c]).size).toBe(3);
  });
});
