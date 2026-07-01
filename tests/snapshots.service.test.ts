import 'reflect-metadata';
import { describe, expect, it, jest } from '@jest/globals';

// The real FileSnapshot is used directly (the lodash-es ESM chain is routed to
// a CommonJS stub via jest.config moduleNameMapper), the same way the
// serialize/restore suite does, so this suite runs against the genuine snapshot
// API rather than a hand-rolled fake.
import { SnapshotsService } from '@/services/snapshots.service';
import * as obsidian from 'obsidian';

import { makeFile } from './helpers/builders';
import { makeSnapshotsService as makeService } from './helpers/service-factories';

type PluginArg = ConstructorParameters<typeof SnapshotsService>[0];

/**
 * Builds a service whose injected SettingsService returns the given allowed
 * extensions and exclude patterns, so the trackable decision (canCapture /
 * isExcludedPath) can be exercised without a real DI container.
 */
const makeServiceWithSettings = (settings: Record<string, unknown>): SnapshotsService => {
  const settingsService = {
    value: (path: string): unknown => settings[path] ?? '',
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
      excludePaths: ['(^|/)Templates/', '(^|/)Daily/'],
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
      excludePaths: [],
    });

    const file = makeFile('Templates/note.md');

    expect(service.isExcludedPath(file)).toBe(false);
    expect(service.canCapture(file)).toBe(true);
  });

  it('excludes nothing on an invalid regexp so tracking continues', () => {
    const notice = jest.spyOn(obsidian, 'Notice').mockImplementation(
      function(this: unknown): void {
        // Inert: swallow construction so the "new Notice(...)" call is counted
        // without needing a real Obsidian toast.
      } as unknown as () => obsidian.Notice
    );

    const service = makeServiceWithSettings({
      allowedExtensions: 'md',
      excludePaths: ['[unclosed'],
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
    service.ignoreList.add(file);
    expect(service.getOne(file)).not.toBeNull();
    expect(service.ignoreList.isIgnored(file)).toBe(true);

    service.remove(file);
    service.ignoreList.remove(file);

    expect(service.getOne(file)).toBeNull();
    expect(service.ignoreList.isIgnored(file)).toBe(false);
  });
});

describe('SnapshotsService purgeExcluded', () => {
  it('removes snapshots for paths matching the exclude pattern and returns the count', () => {
    const service = makeServiceWithSettings({
      allowedExtensions: 'md',
      excludePaths: ['(^|/)Templates/'],
    });

    const excluded1 = makeFile('Templates/note.md');
    const excluded2 = makeFile('Templates/draft.md');
    const kept = makeFile('notes/keep.md');

    service.add(excluded1, 'a');
    service.add(excluded2, 'b');
    service.add(kept, 'c');

    const purged = service.purgeExcluded();

    expect(purged).toBe(2);
    expect(service.getOne(excluded1)).toBeNull();
    expect(service.getOne(excluded2)).toBeNull();
    expect(service.getOne(kept)).not.toBeNull();
  });

  it('does not remove snapshots for paths that do not match the exclude pattern', () => {
    const service = makeServiceWithSettings({
      allowedExtensions: 'md',
      excludePaths: ['(^|/)Templates/'],
    });

    const kept = makeFile('notes/keep.md');
    const also = makeFile('daily/today.md');

    service.add(kept, 'x');
    service.add(also, 'y');

    const purged = service.purgeExcluded();

    expect(purged).toBe(0);
    expect(service.getOne(kept)).not.toBeNull();
    expect(service.getOne(also)).not.toBeNull();
  });

  it('returns zero and shows no error when no excluded snapshots exist', () => {
    const service = makeServiceWithSettings({
      allowedExtensions: 'md',
      excludePaths: ['(^|/)Templates/'],
    });

    expect(() => service.purgeExcluded()).not.toThrow();
    expect(service.purgeExcluded()).toBe(0);
  });
});

describe('SnapshotsService lineBreak sniffing', () => {
  it('sniffs \\r\\n from content when no active editor view is present', () => {
    const service = makeService();
    const file = makeFile('windows.md');

    // CRLF content, no active view - the service factory returns undefined for
    // getActiveEditorView, so sniffing must kick in.
    service.add(file, 'line one\r\nline two\r\n');

    const snapshot = service.getOne(file);

    expect(snapshot).not.toBeNull();
    expect((snapshot as { content: { lineBreak: string } }).content.lineBreak).toBe('\r\n');
  });

  it('falls back to \\n when content has no \\r\\n and no active editor view', () => {
    const service = makeService();
    const file = makeFile('unix.md');

    service.add(file, 'line one\nline two\n');

    const snapshot = service.getOne(file);

    expect(snapshot).not.toBeNull();
    expect((snapshot as { content: { lineBreak: string } }).content.lineBreak).toBe('\n');
  });

  it('uses the active editor state lineBreak over content sniffing', () => {
    const settingsService = { value: (path: string): unknown => (path === 'allowedExtensions' ? 'md' : '') };

    // Simulate an active editor view that reports '\r\n' (e.g. Windows file).
    // The content itself uses '\n' so if sniffing wins the result would be '\n'.
    const plugin = {
      getActiveEditorView: (): { state: { lineBreak: string } } => ({ state: { lineBreak: '\r\n' } }),
      get: (): unknown => settingsService,
      t: (key: string): string => key,
    } as unknown as ConstructorParameters<typeof SnapshotsService>[0];

    const service = new SnapshotsService(plugin);
    const file = makeFile('note.md');

    service.add(file, 'line one\nline two\n');

    const snapshot = service.getOne(file);

    expect(snapshot).not.toBeNull();
    // The editor state lineBreak must win over sniffing.
    expect((snapshot as { content: { lineBreak: string } }).content.lineBreak).toBe('\r\n');
  });
});
