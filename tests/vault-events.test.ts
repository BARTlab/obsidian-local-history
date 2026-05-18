import 'reflect-metadata';
import { describe, expect, it, jest } from '@jest/globals';

import { VaultDeleteEvent } from '@/events/vault/delete.event';
import { VaultModifyEvent } from '@/events/vault/modify.event';
import { VaultRenameEvent } from '@/events/vault/rename.event';
import type LineChangeTrackerPlugin from '@/main';
import { EventsService } from '@/services/events.service';
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
  captureExternalChange: jest.Mock;
} => ({
  markDeleted: jest.fn(),
  markMoved: jest.fn(),
  rename: jest.fn(),
  remove: jest.fn(),
  removeFromIgnoreList: jest.fn(),
  captureExternalChange: jest.fn().mockReturnValue(Promise.resolve()),
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

describe('VaultModifyEvent', () => {
  it('routes a tracked file modify to captureExternalChange', () => {
    const service = makeSnapshotsServiceMock();
    const event = new VaultModifyEvent(makePlugin(service));
    const file: TFile = makeFile('notes/a.md');

    event.handler(file);

    expect(service.captureExternalChange).toHaveBeenCalledTimes(1);
    expect(service.captureExternalChange).toHaveBeenCalledWith(file);
  });

  it('short-circuits for non-file abstract files (folders)', () => {
    const service = makeSnapshotsServiceMock();
    const event = new VaultModifyEvent(makePlugin(service));
    const folder: TAbstractFile = new TFolder() as unknown as TAbstractFile;

    event.handler(folder);

    expect(service.captureExternalChange).not.toHaveBeenCalled();
  });

  it('declares the vault.modify event name', () => {
    const service = makeSnapshotsServiceMock();
    const event = new VaultModifyEvent(makePlugin(service));

    expect(event.name).toBe('vault.modify');
  });
});

describe('EventsService registration', () => {
  it('registers VaultModifyEvent inside the deferred vault pass (onLayoutReady)', () => {
    const service = makeSnapshotsServiceMock();
    const registered: string[] = [];

    let layoutReadyCallback: (() => void) | null = null;
    const plugin = {
      app: {
        workspace: {
          onLayoutReady: (cb: () => void): void => {
            layoutReadyCallback = cb;
          },
          on: (name: string): { name: string } => {
            registered.push(`workspace:${name}`);

            return { name };
          },
        },
        vault: {
          on: (name: string): { name: string } => {
            registered.push(`vault:${name}`);

            return { name };
          },
        },
      },
      registerEvent: jest.fn(),
      get: (key: string): unknown => (key === 'SnapshotsService' ? service : undefined),
    } as unknown as LineChangeTrackerPlugin;

    const events = new EventsService(plugin);

    events.init();

    // Workspace events register synchronously; vault events wait for layout-ready.
    expect(registered.some((entry: string): boolean => entry.startsWith('vault:'))).toBe(false);
    expect(layoutReadyCallback).not.toBeNull();

    (layoutReadyCallback as unknown as () => void)();

    expect(registered).toContain('vault:modify');
    expect(registered).toContain('vault:create');
    expect(registered).toContain('vault:rename');
    expect(registered).toContain('vault:delete');
  });
});
