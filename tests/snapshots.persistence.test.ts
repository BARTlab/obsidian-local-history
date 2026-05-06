import 'reflect-metadata';
import { describe, expect, it } from '@jest/globals';
import { SnapshotsService } from '@/services/snapshots.service';
import { FileSnapshot } from '@/snapshots/file.snapshot';
import type { SerializedFileSnapshot } from '@/types';
import type { TFile } from 'obsidian';

/**
 * Tests for SnapshotsService serialize/restore (T5.1). They use the real
 * FileSnapshot so the serialize -> restore path is exercised end to end,
 * including the pristine-overwrite rule and skipping files that no longer exist.
 */

type PluginArg = ConstructorParameters<typeof SnapshotsService>[0];

const makeFile = (path: string): TFile =>
  ({ path, name: path.split('/').pop() ?? path } as unknown as TFile);

/**
 * Builds a service whose host plugin resolves only the given set of paths to
 * live files (mimicking the vault index after some files were deleted offline).
 */
const makeService = (existingPaths: string[] = []): SnapshotsService => {
  const present: Set<string> = new Set(existingPaths);

  const plugin = {
    getActiveEditorView: (): undefined => undefined,
    getFileByPath: (path: string): TFile | null => (present.has(path) ? makeFile(path) : null),
  } as unknown as PluginArg;

  return new SnapshotsService(plugin);
};

describe('SnapshotsService.serialize', () => {
  it('includes only snapshots that have tracked changes', () => {
    const service = makeService();
    const clean = makeFile('clean.md');
    const dirty = makeFile('dirty.md');

    service.add(clean, 'a\nb');
    service.add(dirty, 'a\nb');

    const dirtySnapshot: FileSnapshot = service.getOne(dirty);
    dirtySnapshot.findCurrentLine(1)?.change('B');
    dirtySnapshot.updateState(['a', 'B']);
    dirtySnapshot.updateChanges();

    const payload = service.serialize();

    expect(payload.version).toBe(1);
    expect(payload.snapshots).toHaveLength(1);
    expect(payload.snapshots[0].path).toBe('dirty.md');
  });
});

describe('SnapshotsService.restore', () => {
  const dirtySerialized = (path: string): SerializedFileSnapshot => {
    const snapshot = new FileSnapshot('a\nb\nc', '\n', makeFile(path));
    snapshot.findCurrentLine(1)?.change('B');
    snapshot.updateState(['a', 'B', 'c']);
    snapshot.updateChanges();

    return snapshot.toJSON();
  };

  it('rebuilds snapshots and attaches the live file', () => {
    const service = makeService(['a.md']);

    service.restore([dirtySerialized('a.md')]);

    const restored: FileSnapshot | null = service.getOne(makeFile('a.md'));
    expect(restored).not.toBeNull();
    expect(restored?.getChangesLinesCount()).toBe(1);
    expect(restored?.file?.path).toBe('a.md');
  });

  it('skips entries whose file no longer exists', () => {
    const service = makeService([]); // nothing resolves

    service.restore([dirtySerialized('gone.md')]);

    expect(service.getOne(makeFile('gone.md'))).toBeNull();
  });

  it('overwrites a pristine in-memory snapshot with restored history', () => {
    const service = makeService(['a.md']);

    // Pristine capture already in memory (no changes).
    service.add(makeFile('a.md'), 'a\nb\nc');
    expect(service.getOne(makeFile('a.md'))?.getChangesLinesCount()).toBe(0);

    service.restore([dirtySerialized('a.md')]);

    expect(service.getOne(makeFile('a.md'))?.getChangesLinesCount()).toBe(1);
  });

  it('does not clobber an in-memory snapshot that already has changes', () => {
    const service = makeService(['a.md']);

    service.add(makeFile('a.md'), 'a\nb\nc');
    const live: FileSnapshot = service.getOne(makeFile('a.md'));
    live.findCurrentLine(0)?.change('Z');
    live.updateState(['Z', 'b', 'c']);
    live.updateChanges();

    service.restore([dirtySerialized('a.md')]);

    // The session edit wins; restored history is discarded for this path.
    expect(service.getOne(makeFile('a.md'))?.getLastStateLines()).toEqual(['Z', 'b', 'c']);
  });

  it('ignores malformed input', () => {
    const service = makeService(['a.md']);

    service.restore(null as unknown as SerializedFileSnapshot[]);
    service.restore([null as unknown as SerializedFileSnapshot]);
    service.restore([{ path: '' } as SerializedFileSnapshot]);

    expect(service.getList()).toHaveLength(0);
  });
});
