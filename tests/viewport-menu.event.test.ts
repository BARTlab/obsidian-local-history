import 'reflect-metadata';
import { describe, expect, it, vi, type Mock } from 'vitest';

import { WorkspaceViewportMenuEvent } from '@/events/workspace/viewport-menu.event';
import type LineChangeTrackerPlugin from '@/main';
import type { SettingsService } from '@/services/settings.service';
import { TOKENS } from '@/services/tokens';
import type { MarkdownView } from 'obsidian';

/**
 * Recorder for the single flat MenuItem the viewport handler builds: it sets a
 * section, title, icon, checked state, and an onClick, all chainable. The mock
 * captures each so a test can assert the toggle's placement/checked state and
 * fire its click.
 */
type RecordedItem = {
  section: string;
  title: string;
  icon: string;
  checked: boolean | undefined;
  click: (() => void) | undefined;
};

interface MockMenu {
  addItem: Mock;
  items: RecordedItem[];
}

const makeMenuItem = (record: RecordedItem): unknown => {
  const item = {
    setSection: (section: string): unknown => {
      record.section = section;

      return item;
    },
    setTitle: (title: string): unknown => {
      record.title = title;

      return item;
    },
    setIcon: (icon: string): unknown => {
      record.icon = icon;

      return item;
    },
    setChecked: (checked: boolean): unknown => {
      record.checked = checked;

      return item;
    },
    onClick: (cb: () => void): unknown => {
      record.click = cb;

      return item;
    },
  };

  return item;
};

const makeMenu = (): MockMenu => {
  const items: RecordedItem[] = [];
  const addItem = vi.fn((build: (item: unknown) => void): unknown => {
    const record: RecordedItem = {
      section: '',
      title: '',
      icon: '',
      checked: undefined,
      click: undefined,
    };

    build(makeMenuItem(record));
    items.push(record);

    return undefined;
  });

  return { addItem: addItem as unknown as Mock, items };
};

/**
 * Builds a WorkspaceViewportMenuEvent over a container-shaped plugin stub whose
 * @Inject settings field resolves to a mock reporting `shown` for the current
 * show-changes state and recording the toggle call.
 */
const makeContext = (
  shown: boolean,
): {
  event: WorkspaceViewportMenuEvent;
  settings: { isShowChangesEnabled: Mock; toggleShowChanges: Mock };
} => {
  const settings = {
    isShowChangesEnabled: vi.fn().mockReturnValue(shown),
    toggleShowChanges: vi.fn(),
  };

  const container: Map<unknown, unknown> = new Map<unknown, unknown>([
    [TOKENS.settings, settings as unknown as SettingsService],
  ]);

  const plugin = {
    get: (key: unknown): unknown => container.get(key),
    t: (key: string): string => key,
  } as unknown as LineChangeTrackerPlugin;

  return { event: new WorkspaceViewportMenuEvent(plugin), settings };
};

type HandlerArgs = Parameters<WorkspaceViewportMenuEvent['handler']>;

const fire = (event: WorkspaceViewportMenuEvent, menu: MockMenu): void => {
  event.handler(menu as unknown as HandlerArgs[0], {} as MarkdownView, 'source', 'gutter');
};

describe('WorkspaceViewportMenuEvent', () => {
  it('declares the workspace.markdown-viewport-menu event name', () => {
    const { event } = makeContext(true);

    expect(event.name).toBe('workspace.markdown-viewport-menu');
  });

  it('adds a checked Show changes toggle in the view section when changes are shown', () => {
    const { event } = makeContext(true);
    const menu = makeMenu();

    fire(event, menu);

    expect(menu.addItem).toHaveBeenCalledTimes(1);
    expect(menu.items[0].section).toBe('view');
    expect(menu.items[0].title).toBe('menu.show-changes');
    expect(menu.items[0].icon).toBe('eye');
    expect(menu.items[0].checked).toBe(true);
  });

  it('adds an unchecked toggle when changes are hidden', () => {
    const { event } = makeContext(false);
    const menu = makeMenu();

    fire(event, menu);

    expect(menu.items[0].checked).toBe(false);
  });

  it('turns changes off when the toggle is clicked while they are shown', () => {
    const { event, settings } = makeContext(true);
    const menu = makeMenu();

    fire(event, menu);
    menu.items[0].click?.();

    expect(settings.toggleShowChanges).toHaveBeenCalledTimes(1);
    expect(settings.toggleShowChanges).toHaveBeenCalledWith(false);
  });

  it('turns changes on when the toggle is clicked while they are hidden', () => {
    const { event, settings } = makeContext(false);
    const menu = makeMenu();

    fire(event, menu);
    menu.items[0].click?.();

    expect(settings.toggleShowChanges).toHaveBeenCalledTimes(1);
    expect(settings.toggleShowChanges).toHaveBeenCalledWith(true);
  });
});
