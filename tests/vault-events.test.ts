import 'reflect-metadata';
import { describe, expect, it, jest } from '@jest/globals';

import { VaultCreateEvent } from '@/events/vault/create.event';
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
  scheduleExternalCapture: jest.Mock;
} => ({
  markDeleted: jest.fn(),
  markMoved: jest.fn(),
  rename: jest.fn(),
  remove: jest.fn(),
  removeFromIgnoreList: jest.fn(),
  captureExternalChange: jest.fn().mockReturnValue(Promise.resolve()),
  scheduleExternalCapture: jest.fn(),
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
  it('routes a tracked file modify to scheduleExternalCapture (debounced)', () => {
    // ADR-08-E: the handler hands off to the debounced/in-flight-guarded
    // scheduler so a burst of modify events for the same file collapses
    // into one capture instead of N redundant disk reads + hashes.
    const service = makeSnapshotsServiceMock();
    const event = new VaultModifyEvent(makePlugin(service));
    const file: TFile = makeFile('notes/a.md');

    event.handler(file);

    expect(service.scheduleExternalCapture).toHaveBeenCalledTimes(1);
    expect(service.scheduleExternalCapture).toHaveBeenCalledWith(file);
    expect(service.captureExternalChange).not.toHaveBeenCalled();
  });

  it('short-circuits for non-file abstract files (folders)', () => {
    const service = makeSnapshotsServiceMock();
    const event = new VaultModifyEvent(makePlugin(service));
    const folder: TAbstractFile = new TFolder() as unknown as TAbstractFile;

    event.handler(folder);

    expect(service.scheduleExternalCapture).not.toHaveBeenCalled();
    expect(service.captureExternalChange).not.toHaveBeenCalled();
  });

  it('declares the vault.modify event name', () => {
    const service = makeSnapshotsServiceMock();
    const event = new VaultModifyEvent(makePlugin(service));

    expect(event.name).toBe('vault.modify');
  });
});

describe('VaultCreateEvent', () => {
  /**
   * Builds the create-event collaborators: a snapshots mock exposing the three
   * entry points the handler touches, plus a settings mock whose
   * `ignoreNewFiles` value the test controls. The handler reaches both services
   * via `plugin.get`, so the plugin stub routes the two keys accordingly.
   */
  const makeCreateContext = (
    ignoreNewFiles: boolean,
  ): {
    event: VaultCreateEvent;
    snapshots: { isInAllowedExtensions: jest.Mock; addToIgnoreList: jest.Mock; capture: jest.Mock };
  } => {
    const snapshots = {
      isInAllowedExtensions: jest.fn().mockReturnValue(true),
      addToIgnoreList: jest.fn(),
      capture: jest.fn().mockReturnValue(Promise.resolve()),
    };
    const settings = { value: jest.fn().mockReturnValue(ignoreNewFiles) };
    const plugin = {
      get: (key: string): unknown => {
        if (key === 'SnapshotsService') {
          return snapshots;
        }

        if (key === 'SettingsService') {
          return settings;
        }

        return undefined;
      },
    } as unknown as LineChangeTrackerPlugin;

    return { event: new VaultCreateEvent(plugin), snapshots };
  };

  it('captures a baseline snapshot when new files are not ignored', () => {
    const { event, snapshots } = makeCreateContext(false);
    const file: TFile = makeFile('notes/sub/copied.md');

    event.handler(file);

    expect(snapshots.capture).toHaveBeenCalledTimes(1);
    expect(snapshots.capture).toHaveBeenCalledWith(file);
    expect(snapshots.addToIgnoreList).not.toHaveBeenCalled();
  });

  it('adds the file to the ignore list (no capture) when ignoreNewFiles is on', () => {
    const { event, snapshots } = makeCreateContext(true);
    const file: TFile = makeFile('notes/sub/copied.md');

    event.handler(file);

    expect(snapshots.addToIgnoreList).toHaveBeenCalledTimes(1);
    expect(snapshots.addToIgnoreList).toHaveBeenCalledWith(file);
    expect(snapshots.capture).not.toHaveBeenCalled();
  });

  it('short-circuits for non-file abstract files (folders)', () => {
    const { event, snapshots } = makeCreateContext(false);
    const folder: TAbstractFile = new TFolder() as unknown as TAbstractFile;

    event.handler(folder);

    expect(snapshots.capture).not.toHaveBeenCalled();
    expect(snapshots.addToIgnoreList).not.toHaveBeenCalled();
  });

  it('declares the vault.create event name', () => {
    const { event } = makeCreateContext(false);

    expect(event.name).toBe('vault.create');
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
