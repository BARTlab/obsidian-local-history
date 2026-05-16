import 'reflect-metadata';
import { describe, expect, it, jest } from '@jest/globals';

import { VaultDeleteEvent } from '@/events/vault/delete.event';
import { VaultRenameEvent } from '@/events/vault/rename.event';
import type LineChangeTrackerPlugin from '@/main';
import type { SnapshotsService } from '@/services/snapshots.service';
import { TFile, TFolder } from 'obsidian';
import type { TAbstractFile } from 'obsidian';

/**
 * Builds a minimal SnapshotsService mock that records calls to the three entry
 * points the vault event handlers touch. The handlers reach the service via
 * `plugin.get('SnapshotsService')`, so the plugin stub below returns this mock.
 */
const makeSnapshotsServiceMock = (): {
  markDeleted: jest.Mock;
  markMoved: jest.Mock;
  rename: jest.Mock;
  remove: jest.Mock;
  removeFromIgnoreList: jest.Mock;
} => ({
  markDeleted: jest.fn(),
  markMoved: jest.fn(),
  rename: jest.fn(),
  remove: jest.fn(),
  removeFromIgnoreList: jest.fn(),
});

const makePlugin = (
  service: ReturnType<typeof makeSnapshotsServiceMock>,
): LineChangeTrackerPlugin => ({
  get: (key: string | unknown): unknown => {
    if (key === 'SnapshotsService') {
      return service as unknown as SnapshotsService;
    }

    return undefined;
  },
}) as unknown as LineChangeTrackerPlugin;

const makeFile = (path: string): TFile => {
  const file = new TFile();
  const name: string = path.split('/').pop() ?? path;

  file.path = path;
  file.name = name;
  file.extension = name.includes('.') ? name.split('.').pop() ?? '' : '';

  return file;
};

describe('VaultDeleteEvent', () => {
  it('routes a tracked file to markDeleted and clears the ignore list', () => {
    const service = makeSnapshotsServiceMock();
    const event = new VaultDeleteEvent(makePlugin(service));
    const file: TFile = makeFile('notes/a.md');

    event.handler(file);

    expect(service.markDeleted).toHaveBeenCalledTimes(1);
    expect(service.markDeleted).toHaveBeenCalledWith(file);
    expect(service.remove).not.toHaveBeenCalled();
    expect(service.removeFromIgnoreList).toHaveBeenCalledTimes(1);
    expect(service.removeFromIgnoreList).toHaveBeenCalledWith(file);
  });

  it('short-circuits for non-file abstract files (folders)', () => {
    const service = makeSnapshotsServiceMock();
    const event = new VaultDeleteEvent(makePlugin(service));
    const folder: TAbstractFile = new TFolder() as unknown as TAbstractFile;

    event.handler(folder);

    expect(service.markDeleted).not.toHaveBeenCalled();
    expect(service.remove).not.toHaveBeenCalled();
    expect(service.removeFromIgnoreList).not.toHaveBeenCalled();
  });
});

describe('VaultRenameEvent', () => {
  it('routes an in-place rename to the re-key path (rename), not markMoved', () => {
    const service = makeSnapshotsServiceMock();
    const event = new VaultRenameEvent(makePlugin(service));
    const file: TFile = makeFile('notes/b.md');

    event.handler(file, 'notes/a.md');

    expect(service.rename).toHaveBeenCalledTimes(1);
    expect(service.rename).toHaveBeenCalledWith('notes/a.md', file);
    expect(service.markMoved).not.toHaveBeenCalled();
  });

  it('routes a cross-directory rename to markMoved', () => {
    const service = makeSnapshotsServiceMock();
    const event = new VaultRenameEvent(makePlugin(service));
    const file: TFile = makeFile('archive/a.md');

    event.handler(file, 'notes/a.md');

    expect(service.markMoved).toHaveBeenCalledTimes(1);
    expect(service.markMoved).toHaveBeenCalledWith('notes/a.md', file);
    expect(service.rename).not.toHaveBeenCalled();
  });

  it('treats vault-root <-> subfolder as a directory change (markMoved)', () => {
    const service = makeSnapshotsServiceMock();
    const event = new VaultRenameEvent(makePlugin(service));
    const file: TFile = makeFile('notes/a.md');

    event.handler(file, 'a.md');

    expect(service.markMoved).toHaveBeenCalledTimes(1);
    expect(service.markMoved).toHaveBeenCalledWith('a.md', file);
    expect(service.rename).not.toHaveBeenCalled();
  });

  it('treats vault-root -> vault-root (no directory) as an in-place rename', () => {
    const service = makeSnapshotsServiceMock();
    const event = new VaultRenameEvent(makePlugin(service));
    const file: TFile = makeFile('b.md');

    event.handler(file, 'a.md');

    expect(service.rename).toHaveBeenCalledTimes(1);
    expect(service.rename).toHaveBeenCalledWith('a.md', file);
    expect(service.markMoved).not.toHaveBeenCalled();
  });

  it('short-circuits for non-file abstract files (folders)', () => {
    const service = makeSnapshotsServiceMock();
    const event = new VaultRenameEvent(makePlugin(service));
    const folder: TAbstractFile = new TFolder() as unknown as TAbstractFile;

    event.handler(folder, 'old/path');

    expect(service.rename).not.toHaveBeenCalled();
    expect(service.markMoved).not.toHaveBeenCalled();
  });
});
