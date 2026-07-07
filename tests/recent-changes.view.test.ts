/** @vitest-environment jsdom */

import { beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { TOKENS } from '@/services/tokens';
import { FileSnapshot } from '@/snapshots/file.snapshot';
import { FileVersion } from '@/snapshots/file.version';
import { RecentChangesView } from '@/views/recent-changes.view';
import type LineChangeTrackerPlugin from '@/main';
import type { TFile, WorkspaceLeaf } from 'obsidian';

import { makeFile } from './helpers/builders';
import { installJsdomDomPolyfill } from './helpers/jsdom-dom';
import { Menu, type RecordedMenuItem } from './stubs/obsidian';

/**
 * Minimal recording workspace: `on` captures each subscription so a test can
 * fire the native `active-leaf-change` event the view subscribes to in `onOpen`,
 * and `emit` invokes the captured handlers.
 */
interface RecordingWorkspace {
  on(name: string, cb: () => void): unknown;
  emit(name: string): void;
}

/**
 * Behavior suite for {@link RecentChangesView}, the recent-changes side panel.
 * It drives a REAL view instance under jsdom over a lightweight plugin double,
 * so the assertions pin the view's own render and interaction wiring - rendered
 * rows/text for a seeded timeline, content-search filtering, and the row revert
 * acting on the file captured at render time - rather than a mock's behavior.
 * A real {@link FileSnapshot} backs the panel so the timeline the view reads is
 * the genuine one, not a stand-in that could drift from it.
 */
describe('RecentChangesView', () => {
  /**
   * Echoes the translation key so a rendered label/hint is asserted against a
   * stable string; the delta key spells out its counts so a formatted delta is
   * still legible if asserted.
   */
  const t = (key: string, vars?: Record<string, string>): string =>
    vars ? `${key}:${vars.added}/${vars.removed}` : key;

  let activeFile: TFile | null;
  let snapshots: { getOne: Mock };
  let modals: { confirm: Mock; diff: Mock; labelVersion: Mock };
  let versionActions: { restoreSelected: Mock; removeSelected: Mock };
  let workspace: RecordingWorkspace;

  const makeWorkspace = (): RecordingWorkspace => {
    const handlers: Map<string, (() => void)[]> = new Map();

    return {
      on: (name: string, cb: () => void): unknown => {
        const list: (() => void)[] = handlers.get(name) ?? [];

        list.push(cb);
        handlers.set(name, list);

        return { name };
      },
      emit: (name: string): void => {
        (handlers.get(name) ?? []).forEach((cb: () => void): void => cb());
      },
    };
  };

  /**
   * Builds a container-shaped plugin double: the DI tokens resolve to the test
   * service doubles, `getActiveFile` reads the mutable active file, and `t`
   * echoes keys. `on`/`off` are inert recorders for the snapshots-update seam.
   */
  const makePlugin = (): LineChangeTrackerPlugin => {
    const services: Map<unknown, unknown> = new Map<unknown, unknown>([
      [TOKENS.snapshots, snapshots],
      [TOKENS.modals, modals],
      [TOKENS.versionActions, versionActions],
    ]);

    return {
      t,
      getActiveFile: (): TFile | null => activeFile,
      get: (token: unknown): unknown => services.get(token),
      on: vi.fn(),
      off: vi.fn(),
    } as unknown as LineChangeTrackerPlugin;
  };

  /**
   * Builds a snapshot whose live state is `current` and whose timeline is the
   * given versions, oldest first (the order the snapshot stores them in, so the
   * panel renders them newest first).
   */
  const makeSnapshot = (current: string, versionsOldestFirst: FileVersion[]): FileSnapshot => {
    const snapshot: FileSnapshot = new FileSnapshot(current);

    snapshot.timeline.adopt(versionsOldestFirst);

    return snapshot;
  };

  /** Constructs a real view over a fresh plugin double and runs its `onOpen`. */
  const mountView = async (): Promise<RecentChangesView> => {
    workspace = makeWorkspace();

    const leaf: WorkspaceLeaf = { app: { workspace } } as unknown as WorkspaceLeaf;
    const view: RecentChangesView = new RecentChangesView(leaf, makePlugin());

    await (view as unknown as { onOpen(): Promise<void> }).onOpen();

    return view;
  };

  /** Types `value` into the mounted search box, firing the view's onChange. */
  const typeSearch = (view: RecentChangesView, value: string): void => {
    const input: HTMLInputElement | null = view.contentEl.querySelector('.lct-recent-changes-search input');

    if (!input) {
      throw new Error('search input was not mounted');
    }

    input.value = value;
    input.dispatchEvent(new Event('input'));
  };

  const rowsOf = (view: RecentChangesView): HTMLElement[] =>
    Array.from(view.contentEl.querySelectorAll<HTMLElement>('.lct-recent-changes-item'));

  const labelsOf = (view: RecentChangesView): (string | null | undefined)[] =>
    rowsOf(view).map((row: HTMLElement): string | null | undefined =>
      row.querySelector('.lct-recent-changes-label')?.textContent);

  beforeAll((): void => {
    // The shared polyfill installs both `empty` and `addClass`, the Obsidian
    // HTMLElement augmentations jsdom lacks that the view's `onOpen` path calls.
    installJsdomDomPolyfill();
  });

  beforeEach((): void => {
    activeFile = null;
    snapshots = { getOne: vi.fn().mockReturnValue(null) };
    modals = { confirm: vi.fn().mockResolvedValue(true), diff: vi.fn(), labelVersion: vi.fn() };
    versionActions = { restoreSelected: vi.fn(), removeSelected: vi.fn() };
    Menu.instances.length = 0;
  });

  it('renders one row per timeline version, newest first, matching the seeded labels and dates', async () => {
    const vOld: FileVersion = new FileVersion(['first draft alpha'], 1000, 'First draft');
    const vNew: FileVersion = new FileVersion(['second pass beta'], 2000, 'Second pass');
    const file: TFile = makeFile('note.md');
    const snapshot: FileSnapshot = makeSnapshot('current live content', [vOld, vNew]);

    activeFile = file;
    snapshots.getOne.mockReturnValue(snapshot);

    const view: RecentChangesView = await mountView();
    const rows: HTMLElement[] = rowsOf(view);

    expect(rows.length).toBe(2);
    expect(labelsOf(view)).toEqual(['Second pass', 'First draft']);
    expect(rows.map((row: HTMLElement): string | null | undefined =>
      row.querySelector('.lct-recent-changes-meta')?.textContent)).toEqual([
      vNew.getDateTime(),
      vOld.getDateTime(),
    ]);
    expect(snapshots.getOne).toHaveBeenCalledWith(file);
  });

  it('renders the empty hint when there is no active file', async () => {
    const view: RecentChangesView = await mountView();

    expect(rowsOf(view).length).toBe(0);
    expect(view.contentEl.querySelector('.lct-recent-changes-empty')?.textContent).toBe('view.recent-changes.empty');
  });

  it('filters rows to the versions whose content matches the query, showing the no-results hint when none match', async () => {
    const vOld: FileVersion = new FileVersion(['first draft alpha'], 1000, 'First draft');
    const vNew: FileVersion = new FileVersion(['second pass beta'], 2000, 'Second pass');
    const snapshot: FileSnapshot = makeSnapshot('current live content', [vOld, vNew]);

    activeFile = makeFile('note.md');
    snapshots.getOne.mockReturnValue(snapshot);

    const view: RecentChangesView = await mountView();

    typeSearch(view, 'alpha');
    expect(labelsOf(view)).toEqual(['First draft']);

    typeSearch(view, 'zzz-no-match');
    expect(rowsOf(view).length).toBe(0);
    expect(view.contentEl.querySelector('.lct-recent-changes-empty')?.textContent).toBe('modal.no-versions-match');
  });

  it('reverts against the file captured at row render time, not the currently active file', async () => {
    const vOld: FileVersion = new FileVersion(['first draft alpha'], 1000, 'First draft');
    const vNew: FileVersion = new FileVersion(['second pass beta'], 2000, 'Second pass');
    const renderedFile: TFile = makeFile('note.md');
    const laterActiveFile: TFile = makeFile('other.md');
    const snapshot: FileSnapshot = makeSnapshot('current live content', [vOld, vNew]);

    activeFile = renderedFile;
    snapshots.getOne.mockReturnValue(snapshot);

    const view: RecentChangesView = await mountView();

    // The active file changes AFTER the rows were rendered against renderedFile.
    activeFile = laterActiveFile;

    rowsOf(view)[0].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));

    const menu: Menu = Menu.instances[Menu.instances.length - 1];
    const revert: RecordedMenuItem | undefined = menu.items.find(
      (item: RecordedMenuItem): boolean => item.title === 'view.recent-changes.menu.restore',
    );

    expect(revert).toBeDefined();

    await revert?.onClick?.();

    expect(modals.confirm).toHaveBeenCalledTimes(1);
    expect(versionActions.restoreSelected).toHaveBeenCalledWith(renderedFile, vNew.id);
  });

  it('clears the search and re-renders the full timeline on active-leaf-change', async () => {
    const vOld: FileVersion = new FileVersion(['first draft alpha'], 1000, 'First draft');
    const vNew: FileVersion = new FileVersion(['second pass beta'], 2000, 'Second pass');
    const snapshot: FileSnapshot = makeSnapshot('current live content', [vOld, vNew]);

    activeFile = makeFile('note.md');
    snapshots.getOne.mockReturnValue(snapshot);

    const view: RecentChangesView = await mountView();

    typeSearch(view, 'alpha');
    expect(rowsOf(view).length).toBe(1);

    workspace.emit('active-leaf-change');

    expect(rowsOf(view).length).toBe(2);
    expect(view.contentEl.querySelector<HTMLInputElement>('.lct-recent-changes-search input')?.value).toBe('');
  });
});
