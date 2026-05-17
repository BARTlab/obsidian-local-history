import 'reflect-metadata';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { WorkspaceFilesMenuEvent } from '@/events/workspace/files-menu.event';
import type LineChangeTrackerPlugin from '@/main';
import type { ModalsService } from '@/services/modals.service';
import { TFile, TFolder } from 'obsidian';
import type { TAbstractFile } from 'obsidian';

/**
 * Recorder for the chain of MenuItem builder calls that the handler issues.
 * Each entry captures the title set on a MenuItem and a reference to its
 * onClick handler so a test can fire any submenu entry by title without
 * threading menu identifiers around.
 */
type RecordedItem = {
  title: string;
  icon: string;
  click: (() => void) | undefined;
};

/**
 * Recorded shape of a mock Menu so a test can walk into the parent's submenu
 * by index. `addItem` is a jest mock that synchronously invokes the builder
 * callback, captures the resulting RecordedItem, and threads a freshly built
 * submenu into the item via `setSubmenu()`.
 */
interface MockMenu {
  addItem: jest.Mock;
  items: RecordedItem[];
  children: MockMenu[];
}

/**
 * Builds a chainable mock MenuItem that records what the handler set on it,
 * plus exposes the captured onClick callback for assertion-time invocation.
 * The handler resolves a submenu via the cast helper
 * `MenuHelper.setSubmenu(item)` (which calls `item.setSubmenu()`), so the
 * mock returns the menu wired in by the caller.
 */
const makeMenuItem = (record: RecordedItem, submenu: MockMenu): unknown => {
  const item = {
    setTitle: (title: string): unknown => {
      record.title = title;

      return item;
    },
    setIcon: (icon: string): unknown => {
      record.icon = icon;

      return item;
    },
    onClick: (cb: () => void): unknown => {
      record.click = cb;

      return item;
    },
    setSubmenu: (): unknown => submenu,
  };

  return item;
};

const makeMenu = (): MockMenu => {
  const items: RecordedItem[] = [];
  const children: MockMenu[] = [];
  const addItem = jest.fn((build: (item: unknown) => void): unknown => {
    const record: RecordedItem = { title: '', icon: '', click: undefined };
    const childSubmenu: MockMenu = makeMenu();
    children.push(childSubmenu);
    build(makeMenuItem(record, childSubmenu));
    items.push(record);

    return undefined;
  });

  return { addItem: addItem as unknown as jest.Mock, items, children };
};

const makeModalsServiceMock = (): {
  diff: jest.Mock<(file?: unknown) => boolean>;
  openFolderHistory: jest.Mock<(folder?: unknown) => boolean>;
  putLabel: jest.Mock<(file?: unknown) => Promise<unknown>>;
} => ({
  diff: jest.fn((_file?: unknown): boolean => true) as unknown as jest.Mock<(file?: unknown) => boolean>,
  openFolderHistory: jest.fn((_folder?: unknown): boolean => false) as unknown as jest.Mock<
    (folder?: unknown) => boolean
  >,
  putLabel: jest.fn(async (_file?: unknown): Promise<unknown> => null) as unknown as jest.Mock<
    (file?: unknown) => Promise<unknown>
  >,
});

const makePlugin = (
  service: ReturnType<typeof makeModalsServiceMock>,
  reveal: jest.Mock,
): LineChangeTrackerPlugin => ({
  get: (key: string | unknown): unknown => {
    if (key === 'ModalsService') {
      return service as unknown as ModalsService;
    }

    return undefined;
  },
  t: (key: string): string => key,
  revealRecentChanges: reveal,
}) as unknown as LineChangeTrackerPlugin;

const makeFile = (path: string): TFile => {
  const file = new TFile();
  const name: string = path.split('/').pop() ?? path;

  file.path = path;
  file.name = name;

  return file;
};

const makeFolder = (path: string): TFolder => {
  const folder = new TFolder();
  const name: string = path.split('/').pop() ?? path;

  folder.path = path;
  folder.name = name;

  return folder;
};

describe('WorkspaceFilesMenuEvent', () => {
  let service: ReturnType<typeof makeModalsServiceMock>;
  let reveal: jest.Mock;
  let event: WorkspaceFilesMenuEvent;

  beforeEach((): void => {
    service = makeModalsServiceMock();
    reveal = jest.fn();
    event = new WorkspaceFilesMenuEvent(makePlugin(service, reveal));
  });

  it('adds a Local history parent with a 3-entry submenu for TFile', () => {
    const file: TFile = makeFile('notes/a.md');
    const menu = makeMenu();

    event.handler(menu as unknown as Parameters<WorkspaceFilesMenuEvent['handler']>[0], file, 'file-explorer');

    // One parent item lands on the top-level menu.
    expect(menu.addItem).toHaveBeenCalledTimes(1);
    expect(menu.items[0].title).toBe('menu.local-history');

    // The submenu attached to the parent receives three entries (D11).
    const submenu = menu.children[0];
    const titles: string[] = submenu.items.map((i: RecordedItem): string => i.title);
    expect(titles).toEqual([
      'menu.local-history.show-history',
      'menu.local-history.put-label',
      'menu.local-history.recent-changes',
    ]);
  });

  it('routes Show History on a TFile to ModalsService.diff(file)', () => {
    const file: TFile = makeFile('notes/a.md');
    const menu = makeMenu();

    event.handler(menu as unknown as Parameters<WorkspaceFilesMenuEvent['handler']>[0], file, 'file-explorer');

    const submenu = menu.children[0];
    const showHistory: RecordedItem = submenu.items[0];

    showHistory.click?.();

    expect(service.diff).toHaveBeenCalledTimes(1);
    expect(service.diff).toHaveBeenCalledWith(file);
  });

  it('falls back without throwing when diff returns false on a TFile', () => {
    const file: TFile = makeFile('notes/a.md');
    const menu = makeMenu();
    service.diff.mockReturnValueOnce(false);

    event.handler(menu as unknown as Parameters<WorkspaceFilesMenuEvent['handler']>[0], file, 'file-explorer');

    const submenu = menu.children[0];

    expect((): void => submenu.items[0].click?.()).not.toThrow();
    expect(service.diff).toHaveBeenCalledTimes(1);
  });

  it('routes Recent changes on a TFile to plugin.revealRecentChanges', () => {
    const file: TFile = makeFile('notes/a.md');
    const menu = makeMenu();

    event.handler(menu as unknown as Parameters<WorkspaceFilesMenuEvent['handler']>[0], file, 'file-explorer');

    const submenu = menu.children[0];
    submenu.items[2].click?.();

    expect(reveal).toHaveBeenCalledTimes(1);
  });

  it('routes Put label on a TFile to ModalsService.putLabel(file)', () => {
    const file: TFile = makeFile('notes/a.md');
    const menu = makeMenu();

    event.handler(menu as unknown as Parameters<WorkspaceFilesMenuEvent['handler']>[0], file, 'file-explorer');

    const submenu = menu.children[0];
    submenu.items[1].click?.();

    expect(service.putLabel).toHaveBeenCalledTimes(1);
    expect(service.putLabel).toHaveBeenCalledWith(file);
  });

  it('adds a Local history parent with a 2-entry submenu for TFolder', () => {
    const folder: TFolder = makeFolder('notes');
    const menu = makeMenu();

    event.handler(menu as unknown as Parameters<WorkspaceFilesMenuEvent['handler']>[0], folder, 'file-explorer');

    expect(menu.addItem).toHaveBeenCalledTimes(1);
    expect(menu.items[0].title).toBe('menu.local-history');

    const submenu = menu.children[0];
    const titles: string[] = submenu.items.map((i: RecordedItem): string => i.title);
    expect(titles).toEqual([
      'menu.local-history.show-history',
      'menu.local-history.recent-changes',
    ]);
  });

  it('routes Show History on a TFolder to ModalsService.openFolderHistory(folder)', () => {
    const folder: TFolder = makeFolder('notes');
    const menu = makeMenu();

    event.handler(menu as unknown as Parameters<WorkspaceFilesMenuEvent['handler']>[0], folder, 'file-explorer');

    const submenu = menu.children[0];
    submenu.items[0].click?.();

    expect(service.openFolderHistory).toHaveBeenCalledTimes(1);
    expect(service.openFolderHistory).toHaveBeenCalledWith(folder);
  });

  it('routes Recent changes on a TFolder to plugin.revealRecentChanges', () => {
    const folder: TFolder = makeFolder('notes');
    const menu = makeMenu();

    event.handler(menu as unknown as Parameters<WorkspaceFilesMenuEvent['handler']>[0], folder, 'file-explorer');

    const submenu = menu.children[0];
    submenu.items[1].click?.();

    expect(reveal).toHaveBeenCalledTimes(1);
  });

  it('short-circuits for a TAbstractFile that is neither a TFile nor a TFolder', () => {
    const menu = makeMenu();
    const other: TAbstractFile = { path: 'something' } as unknown as TAbstractFile;

    event.handler(menu as unknown as Parameters<WorkspaceFilesMenuEvent['handler']>[0], other, 'file-explorer');

    expect(menu.addItem).not.toHaveBeenCalled();
  });
});
