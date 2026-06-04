import 'reflect-metadata';
import { describe, expect, it, jest } from '@jest/globals';

import { VaultCreateEvent } from '@/events/vault/create.event';
import { VaultDeleteEvent } from '@/events/vault/delete.event';
import { VaultModifyEvent } from '@/events/vault/modify.event';
import { VaultRenameEvent } from '@/events/vault/rename.event';
import { WorkspaceLayoutChangeEvent } from '@/events/workspace/layout-change.event';
import { KeepHistory } from '@/consts';
import type { FileSnapshot } from '@/snapshots/file.snapshot';
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
    snapshot: FileSnapshot | null = { createdThisSession: false } as FileSnapshot,
  ): {
    event: VaultCreateEvent;
    snapshots: {
      isInAllowedExtensions: jest.Mock;
      addToIgnoreList: jest.Mock;
      capture: jest.Mock;
      getOne: jest.Mock;
    };
  } => {
    const snapshots = {
      isInAllowedExtensions: jest.fn().mockReturnValue(true),
      addToIgnoreList: jest.fn(),
      capture: jest.fn().mockReturnValue(Promise.resolve()),
      getOne: jest.fn().mockReturnValue(snapshot),
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

  it('stamps createdThisSession on the captured snapshot (epic 11, D4)', async () => {
    const snapshot: FileSnapshot = { createdThisSession: false } as FileSnapshot;
    const { event, snapshots } = makeCreateContext(false, snapshot);
    const file: TFile = makeFile('notes/sub/new.md');

    await event.handler(file);

    expect(snapshots.capture).toHaveBeenCalledWith(file);
    expect(snapshots.getOne).toHaveBeenCalledWith(file);
    expect(snapshot.createdThisSession).toBe(true);
  });

  it('does not throw when the captured snapshot is missing', async () => {
    const { event, snapshots } = makeCreateContext(false, null);
    const file: TFile = makeFile('notes/sub/new.md');

    await event.handler(file);

    expect(snapshots.getOne).toHaveBeenCalledWith(file);
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

describe('WorkspaceLayoutChangeEvent', () => {
  /**
   * Builds a layout-change context with a snapshot store the test can pre-seed,
   * an ignore list, and a workspace-opened-file set. The mock service mirrors
   * just enough of SnapshotsService for the handler to drive its three passes,
   * and records the order of every mutating call so the test can assert that
   * no mutation happens during iteration (ADR-08-E adjacent, T10).
   */
  const makeLayoutContext = (params: {
    snapshots: FileSnapshot[];
    ignored: TFile[];
    opened: TFile[];
    keepOnClose: boolean;
    trackedPaths?: Set<string>;
  }): {
    event: WorkspaceLayoutChangeEvent;
    calls: string[];
    service: {
      getList: jest.Mock;
      getIgnoreList: jest.Mock;
      wipeOne: jest.Mock;
      removeFromIgnoreList: jest.Mock;
      getOne: jest.Mock;
      capture: jest.Mock;
    };
  } => {
    const calls: string[] = [];
    const tracked: Set<string> = params.trackedPaths
      ?? new Set(params.snapshots
        .map((snapshot: FileSnapshot): string | undefined => snapshot.file?.path)
        .filter((path: string | undefined): path is string => Boolean(path))
      );

    const service = {
      getList: jest.fn().mockImplementation((): FileSnapshot[] => {
        calls.push('getList');

        return [...params.snapshots];
      }),
      getIgnoreList: jest.fn().mockImplementation((): TFile[] => {
        calls.push('getIgnoreList');

        return [...params.ignored];
      }),
      wipeOne: jest.fn().mockImplementation((file: TFile): void => {
        calls.push(`wipeOne:${file.path}`);
      }),
      removeFromIgnoreList: jest.fn().mockImplementation((file: TFile): void => {
        calls.push(`removeFromIgnoreList:${file.path}`);
      }),
      getOne: jest.fn().mockImplementation((file: TFile): FileSnapshot | null => {
        calls.push(`getOne:${file.path}`);

        return tracked.has(file.path) ? ({} as FileSnapshot) : null;
      }),
      capture: jest.fn().mockImplementation((file: TFile): Promise<void> => {
        calls.push(`capture:${file.path}`);

        return Promise.resolve();
      }),
    };

    const settings = {
      value: jest.fn().mockReturnValue(params.keepOnClose ? KeepHistory.file : KeepHistory.app),
    };

    const plugin = {
      getWorkspaceFiles: (): Set<TFile> => new Set(params.opened),
      get: (key: string): unknown => {
        if (key === 'SnapshotsService') {
          return service;
        }

        if (key === 'SettingsService') {
          return settings;
        }

        return undefined;
      },
    } as unknown as LineChangeTrackerPlugin;

    return { event: new WorkspaceLayoutChangeEvent(plugin), calls, service };
  };

  const makeSnapshot = (file: TFile): FileSnapshot => ({ file } as FileSnapshot);

  it('does not mutate any collection while it is being iterated (multi-pane change)', () => {
    /**
     * Two snapshots whose files are no longer open, two ignore-list entries
     * also no longer open, and two newly opened files. The handler must
     * collect every decision first and only then call the mutating service
     * methods, so all reads (getList, getIgnoreList, getOne) happen before
     * any write (wipeOne, removeFromIgnoreList, capture).
     */
    const closedA: TFile = makeFile('notes/closed-a.md');
    const closedB: TFile = makeFile('notes/closed-b.md');
    const ignoredA: TFile = makeFile('notes/ign-a.md');
    const ignoredB: TFile = makeFile('notes/ign-b.md');
    const openedA: TFile = makeFile('notes/open-a.md');
    const openedB: TFile = makeFile('notes/open-b.md');

    const { event, calls } = makeLayoutContext({
      snapshots: [makeSnapshot(closedA), makeSnapshot(closedB)],
      ignored: [ignoredA, ignoredB],
      opened: [openedA, openedB],
      keepOnClose: true,
    });

    event.handler();

    /**
     * Find the index of the last read and the first write; the read group
     * must finish strictly before the write group starts.
     */
    const reads: string[] = ['getList', 'getIgnoreList', 'getOne:notes/open-a.md', 'getOne:notes/open-b.md'];
    const writePrefixes: string[] = ['wipeOne:', 'removeFromIgnoreList:', 'capture:'];

    const lastReadIndex: number = Math.max(
      ...reads.map((entry: string): number => calls.lastIndexOf(entry))
    );
    const firstWriteIndex: number = calls.findIndex((entry: string): boolean =>
      writePrefixes.some((prefix: string): boolean => entry.startsWith(prefix))
    );

    expect(lastReadIndex).toBeGreaterThanOrEqual(0);
    expect(firstWriteIndex).toBeGreaterThanOrEqual(0);
    expect(firstWriteIndex).toBeGreaterThan(lastReadIndex);
  });

  it('defers captures until after the iteration completes', () => {
    const opened: TFile = makeFile('notes/new.md');

    const { event, calls } = makeLayoutContext({
      snapshots: [],
      ignored: [],
      opened: [opened],
      keepOnClose: false,
    });

    event.handler();

    /**
     * capture must run after getList/getIgnoreList/getOne, never between
     * them. There is exactly one getList, one getIgnoreList, one getOne
     * before the single capture.
     */
    expect(calls).toEqual([
      'getList',
      'getIgnoreList',
      'getOne:notes/new.md',
      'capture:notes/new.md',
    ]);
  });

  it('keeps single-pane behaviour: closed file wiped, new file captured', () => {
    const closed: TFile = makeFile('notes/closed.md');
    const opened: TFile = makeFile('notes/new.md');

    const { event, service } = makeLayoutContext({
      snapshots: [makeSnapshot(closed)],
      ignored: [],
      opened: [opened],
      keepOnClose: true,
    });

    event.handler();

    expect(service.wipeOne).toHaveBeenCalledTimes(1);
    expect(service.wipeOne).toHaveBeenCalledWith(closed);
    expect(service.capture).toHaveBeenCalledTimes(1);
    expect(service.capture).toHaveBeenCalledWith(opened);
    expect(service.removeFromIgnoreList).not.toHaveBeenCalled();
  });

  it('skips wipe when keep-on-close is off, but still captures new files', () => {
    const stillTracked: TFile = makeFile('notes/closed.md');
    const opened: TFile = makeFile('notes/new.md');

    const { event, service } = makeLayoutContext({
      snapshots: [makeSnapshot(stillTracked)],
      ignored: [],
      opened: [opened],
      keepOnClose: false,
    });

    event.handler();

    expect(service.wipeOne).not.toHaveBeenCalled();
    expect(service.capture).toHaveBeenCalledTimes(1);
    expect(service.capture).toHaveBeenCalledWith(opened);
  });

  it('does not capture a file that already has a snapshot', () => {
    const tracked: TFile = makeFile('notes/tracked.md');

    const { event, service } = makeLayoutContext({
      snapshots: [makeSnapshot(tracked)],
      ignored: [],
      opened: [tracked],
      keepOnClose: false,
      trackedPaths: new Set(['notes/tracked.md']),
    });

    event.handler();

    expect(service.capture).not.toHaveBeenCalled();
    expect(service.wipeOne).not.toHaveBeenCalled();
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
