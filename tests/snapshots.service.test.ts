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
import * as obsidian from 'obsidian';
import type { TFile } from 'obsidian';

type PluginArg = ConstructorParameters<typeof SnapshotsService>[0];

const makeFile = (path: string): TFile => {
  const name: string = path.split('/').pop() ?? path;
  const extension: string = name.includes('.') ? name.split('.').pop() ?? '' : '';

  return { path, name, extension } as unknown as TFile;
};

const makeService = (): SnapshotsService => {
  const plugin = {
    getActiveEditorView: (): undefined => undefined,
    t: (key: string): string => key,
  } as unknown as PluginArg;

  return new SnapshotsService(plugin);
};

/**
 * Builds a service whose injected SettingsService returns the given allowed
 * extensions and exclude patterns, so the trackable decision (canCapture /
 * isExcludedPath) can be exercised without a real DI container.
 */
const makeServiceWithSettings = (settings: Record<string, string>): SnapshotsService => {
  const settingsService = {
    value: (path: string): string => settings[path] ?? '',
  };

  const plugin = {
    getActiveEditorView: (): undefined => undefined,
    get: (): unknown => settingsService,
    t: (key: string): string => key,
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

describe('SnapshotsService path excludes', () => {
  it('flags a path matched by the exclude regexp and keeps it out of canCapture', () => {
    const service = makeServiceWithSettings({
      allowedExtensions: 'md',
      excludePaths: '(^|/)Templates/|(^|/)Daily/',
    });

    const excluded = makeFile('Templates/note.md');
    const nested = makeFile('areas/Daily/2026/05/31.md');
    const tracked = makeFile('notes/keep.md');

    expect(service.isExcludedPath(excluded)).toBe(true);
    expect(service.isExcludedPath(nested)).toBe(true);
    expect(service.isExcludedPath(tracked)).toBe(false);

    // The exclude must veto capture even though the extension is allowed.
    expect(service.canCapture(excluded)).toBe(false);
    expect(service.canCapture(nested)).toBe(false);
    expect(service.canCapture(tracked)).toBe(true);
  });

  it('excludes nothing when the pattern is empty', () => {
    const service = makeServiceWithSettings({
      allowedExtensions: 'md',
      excludePaths: '',
    });

    const file = makeFile('Templates/note.md');

    expect(service.isExcludedPath(file)).toBe(false);
    expect(service.canCapture(file)).toBe(true);
  });

  it('excludes nothing on an invalid regexp so tracking continues', () => {
    const notice = jest.spyOn(obsidian, 'Notice').mockImplementation(
      function (this: unknown): void {
        // Inert: swallow construction so the "new Notice(...)" call is counted
        // without needing a real Obsidian toast.
      } as unknown as () => obsidian.Notice
    );
    const service = makeServiceWithSettings({
      allowedExtensions: 'md',
      excludePaths: '[unclosed',
    });

    const file = makeFile('Templates/note.md');

    expect(service.isExcludedPath(file)).toBe(false);
    expect(service.canCapture(file)).toBe(true);

    // The malformed-pattern warning is shown, but only once for the same
    // pattern even when several files are evaluated.
    service.isExcludedPath(makeFile('Templates/another.md'));
    service.isExcludedPath(makeFile('Daily/x.md'));

    expect(notice).toHaveBeenCalledTimes(1);

    notice.mockRestore();
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
