import 'reflect-metadata';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { WorkspaceEditorMenuEvent } from '@/events/workspace/editor-menu.event';
import type LineChangeTrackerPlugin from '@/main';
import type { ModalsService } from '@/services/modals.service';
import { TOKENS } from '@/services/tokens';
import type { Editor, MarkdownView } from 'obsidian';

/**
 * Recorder for a single MenuItem builder call: the title and icon the handler
 * set, plus the captured onClick so a test can fire the entry by index.
 */
type RecordedItem = {
  title: string;
  icon: string;
  click: (() => void) | undefined;
};

/**
 * Mock Menu that walks into a parent's submenu by index. `addItem` invokes the
 * builder synchronously, records the resulting item, and wires a fresh child
 * submenu into the item via `setSubmenu()`.
 */
interface MockMenu {
  addItem: jest.Mock;
  items: RecordedItem[];
  children: MockMenu[];
}

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
  diff: jest.Mock;
  diffForSelection: jest.Mock;
  putLabel: jest.Mock<() => Promise<unknown>>;
} => ({
  diff: jest.fn(),
  diffForSelection: jest.fn(),
  putLabel: jest.fn(async (): Promise<unknown> => null) as unknown as jest.Mock<() => Promise<unknown>>,
});

const makePlugin = (
  service: ReturnType<typeof makeModalsServiceMock>,
  reveal: jest.Mock,
): LineChangeTrackerPlugin => {
  const container: Map<unknown, unknown> = new Map<unknown, unknown>([
    [TOKENS.modals, service as unknown as ModalsService],
  ]);

  return {
    get: (key: unknown): unknown => container.get(key),
    t: (key: string): string => key,
    revealRecentChanges: reveal,
  } as unknown as LineChangeTrackerPlugin;
};

const makeEditor = (selection: string): Editor =>
  ({ getSelection: (): string => selection } as unknown as Editor);

type HandlerArgs = Parameters<WorkspaceEditorMenuEvent['handler']>;

describe('WorkspaceEditorMenuEvent', () => {
  let service: ReturnType<typeof makeModalsServiceMock>;
  let reveal: jest.Mock;
  let event: WorkspaceEditorMenuEvent;

  beforeEach((): void => {
    service = makeModalsServiceMock();
    reveal = jest.fn();
    event = new WorkspaceEditorMenuEvent(makePlugin(service, reveal));
  });

  it('declares the workspace.editor-menu event name', () => {
    expect(event.name).toBe('workspace.editor-menu');
  });

  it('adds a Local history parent with the four PhpStorm-style submenu entries', () => {
    const menu = makeMenu();

    event.handler(menu as unknown as HandlerArgs[0], makeEditor(''), {} as MarkdownView);

    // One parent item lands on the top-level menu.
    expect(menu.addItem).toHaveBeenCalledTimes(1);
    expect(menu.items[0].title).toBe('menu.local-history');
    expect(menu.items[0].icon).toBe('file-diff');

    const submenu = menu.children[0];
    const titles: string[] = submenu.items.map((i: RecordedItem): string => i.title);
    expect(titles).toEqual([
      'menu.local-history.show-history',
      'menu.local-history.show-history-selection',
      'menu.local-history.put-label',
      'menu.local-history.recent-changes',
    ]);
  });

  it('routes Show History to ModalsService.diff', () => {
    const menu = makeMenu();

    event.handler(menu as unknown as HandlerArgs[0], makeEditor(''), {} as MarkdownView);
    menu.children[0].items[0].click?.();

    expect(service.diff).toHaveBeenCalledTimes(1);
  });

  it('routes Show History for Selection to diffForSelection with the editor selection', () => {
    const menu = makeMenu();

    event.handler(menu as unknown as HandlerArgs[0], makeEditor('picked text'), {} as MarkdownView);
    menu.children[0].items[1].click?.();

    expect(service.diffForSelection).toHaveBeenCalledTimes(1);
    expect(service.diffForSelection).toHaveBeenCalledWith(null, 'picked text');
  });

  it('routes Put label to ModalsService.putLabel', () => {
    const menu = makeMenu();

    event.handler(menu as unknown as HandlerArgs[0], makeEditor(''), {} as MarkdownView);
    menu.children[0].items[2].click?.();

    expect(service.putLabel).toHaveBeenCalledTimes(1);
  });

  it('routes Recent changes to plugin.revealRecentChanges', () => {
    const menu = makeMenu();

    event.handler(menu as unknown as HandlerArgs[0], makeEditor(''), {} as MarkdownView);
    menu.children[0].items[3].click?.();

    expect(reveal).toHaveBeenCalledTimes(1);
  });
});
