import 'reflect-metadata';
import { describe, expect, it, jest } from '@jest/globals';

// Replace the real FileSnapshot so the test stays hermetic and does not pull
// the lodash-es (ESM) chain into the CommonJS Jest runtime. Only the fields
// touched by SnapshotsService rename/remove are needed here.
jest.mock('@/snapshots/file.snapshot', () => ({
  FileSnapshot: class {
    public file: unknown;
    public lines: string[];

    public constructor(content: string, _lineBreak?: string, file?: unknown) {
      this.file = file;
      this.lines = typeof content === 'string' ? content.split('\n') : [];
    }
  },
}));

import { SnapshotsService } from '@/services/snapshots.service';
import type { TFile } from 'obsidian';

type PluginArg = ConstructorParameters<typeof SnapshotsService>[0];

const makeFile = (path: string): TFile =>
  ({ path, name: path.split('/').pop() ?? path } as unknown as TFile);

const makeService = (): SnapshotsService => {
  const plugin = {
    getActiveEditorView: (): undefined => undefined,
  } as unknown as PluginArg;

  return new SnapshotsService(plugin);
};

describe('SnapshotsService rename', () => {
  it('re-keys a snapshot to the new path and preserves the instance', () => {
    const service = makeService();
    const before = makeFile('notes/a.md');
    const after = makeFile('notes/b.md');

    service.add(before, 'line 1\nline 2');
    const original = service.getOne(before);
    expect(original).not.toBeNull();

    service.rename(before.path, after);

    expect(service.getOne(after)).toBe(original);
    expect(service.getOne(before)).toBeNull();
  });

  it('updates the stored file reference on rename', () => {
    const service = makeService();
    const before = makeFile('a.md');
    const after = makeFile('b.md');

    service.add(before, 'x');
    service.rename(before.path, after);

    expect(service.getOne(after)?.file).toBe(after);
  });

  it('does nothing when no snapshot exists at the old path', () => {
    const service = makeService();
    const after = makeFile('b.md');

    service.rename('missing.md', after);

    expect(service.getOne(after)).toBeNull();
  });
});

describe('SnapshotsService delete', () => {
  it('removes the snapshot and the ignore-list entry', () => {
    const service = makeService();
    const file = makeFile('a.md');

    service.add(file, 'x');
    service.addToIgnoreList(file);
    expect(service.getOne(file)).not.toBeNull();
    expect(service.isInIgnoreList(file)).toBe(true);

    service.remove(file);
    service.removeFromIgnoreList(file);

    expect(service.getOne(file)).toBeNull();
    expect(service.isInIgnoreList(file)).toBe(false);
  });
});
