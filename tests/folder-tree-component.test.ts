/** @jest-environment jsdom */

import { describe, expect, it, beforeAll, beforeEach } from '@jest/globals';
import { FolderDeltaStatus } from '@/consts';
import { FolderTreeComponent, type FolderTreeEntry } from '@/components/folder-tree.component';

/**
 * Tests for {@link FolderTreeComponent} (T11 / D9).
 *
 * The component renders the per-folder "changes since T" tree in the middle
 * column of the folder modal. The tests run under jsdom and exercise the AC
 * grid:
 *
 * - AC1: only files with status `added | modified | deleted` render, plus the
 *   minimum ancestor folders that keep them connected to the root.
 * - AC2: status-class mapping (added -> lct-tree-added, modified -> -modified,
 *   deleted -> -deleted).
 * - AC3: clicking a file row emits a selection event with the path and applies
 *   `is-active` to that row.
 * - AC4: clicking a folder row collapses / expands its children, with the
 *   collapsed state surviving an update call within one mount.
 * - AC5: an empty input shows the inline localized "no changes" hint.
 */
describe('FolderTreeComponent', () => {
  /**
   * jsdom does not implement HTMLElement.empty (Obsidian augments the prototype
   * at runtime). The component calls empty() before each render, so the
   * polyfill must exist for every test.
   */
  beforeAll((): void => {
    if (!(HTMLElement.prototype as unknown as { empty?: () => void }).empty) {
      (HTMLElement.prototype as unknown as { empty: () => void }).empty = function emptyImpl(this: HTMLElement): void {
        while (this.firstChild) {
          this.removeChild(this.firstChild);
        }
      };
    }
  });

  let host: HTMLDivElement;
  let component: FolderTreeComponent;
  let selectedPaths: string[];

  /**
   * Each test gets a fresh container and a fresh component so collapse / select
   * state from previous cases does not leak between assertions.
   */
  beforeEach((): void => {
    host = document.createElement('div');
    document.body.appendChild(host);

    component = new FolderTreeComponent();
    selectedPaths = [];

    component.mount(host, (path: string): void => {
      selectedPaths.push(path);
    });
  });

  /**
   * Convenience: build a basic entry list under root `notes/` with one added
   * file in a nested folder, one modified file at the root level, and one
   * deleted file in another nested folder. Two unchanged entries are sprinkled
   * in to verify the status filter.
   *
   * @return {FolderTreeEntry[]} The fixture entries
   */
  const fixture = (): FolderTreeEntry[] => [
    { path: 'notes/sub/added.md', status: FolderDeltaStatus.added },
    { path: 'notes/direct-modified.md', status: FolderDeltaStatus.modified },
    { path: 'notes/sub/deleted.md', status: FolderDeltaStatus.deleted },
    { path: 'notes/unchanged.md', status: FolderDeltaStatus.none },
    { path: 'notes/other/unchanged-deep.md', status: FolderDeltaStatus.none },
  ];

  describe('AC1: only changed files plus their ancestor folders render', () => {
    it('renders the three changed files and one ancestor folder', (): void => {
      component.update({ entries: fixture(), rootPath: 'notes' });

      const fileRows: NodeListOf<HTMLElement> = host.querySelectorAll<HTMLElement>('.lct-folder-tree-file');
      const paths: string[] = Array.from(fileRows).map(
        (row: HTMLElement): string => row.getAttribute('data-path') ?? '',
      );

      expect(paths.sort()).toEqual(['notes/direct-modified.md', 'notes/sub/added.md', 'notes/sub/deleted.md']);

      // The only ancestor folder needed is `notes/sub` (the modified file lives
      // at the root level of the tree). The unchanged `notes/other` folder
      // never renders because its only child has status `'none'`.
      const folderRows: NodeListOf<HTMLElement> = host.querySelectorAll<HTMLElement>('.lct-folder-tree-folder');
      const folderPaths: string[] = Array.from(folderRows).map(
        (row: HTMLElement): string => row.getAttribute('data-path') ?? '',
      );

      expect(folderPaths).toEqual(['notes/sub']);
    });

    it('drops entries that lie outside the root prefix', (): void => {
      const entries: FolderTreeEntry[] = [
        { path: 'notes/inside.md', status: FolderDeltaStatus.added },
        { path: 'other/outside.md', status: FolderDeltaStatus.added },
      ];

      component.update({ entries, rootPath: 'notes' });

      const fileRows: NodeListOf<HTMLElement> = host.querySelectorAll<HTMLElement>('.lct-folder-tree-file');
      const paths: string[] = Array.from(fileRows).map(
        (row: HTMLElement): string => row.getAttribute('data-path') ?? '',
      );

      expect(paths).toEqual(['notes/inside.md']);
    });

    it('treats an empty root path as the whole vault', (): void => {
      const entries: FolderTreeEntry[] = [
        { path: 'a.md', status: FolderDeltaStatus.modified },
        { path: 'sub/b.md', status: FolderDeltaStatus.added },
      ];

      component.update({ entries, rootPath: '' });

      const fileRows: NodeListOf<HTMLElement> = host.querySelectorAll<HTMLElement>('.lct-folder-tree-file');
      const paths: string[] = Array.from(fileRows).map(
        (row: HTMLElement): string => row.getAttribute('data-path') ?? '',
      );

      expect(paths.sort()).toEqual(['a.md', 'sub/b.md']);
    });
  });

  describe('AC2: status maps to colour-token class', () => {
    it('assigns lct-tree-added / -modified / -deleted to the matching rows', (): void => {
      component.update({ entries: fixture(), rootPath: 'notes' });

      const added: HTMLElement | null = host.querySelector<HTMLElement>('[data-path="notes/sub/added.md"]');
      const modified: HTMLElement | null = host.querySelector<HTMLElement>('[data-path="notes/direct-modified.md"]');
      const deleted: HTMLElement | null = host.querySelector<HTMLElement>('[data-path="notes/sub/deleted.md"]');

      expect(added?.classList.contains('lct-tree-added')).toBe(true);
      expect(modified?.classList.contains('lct-tree-modified')).toBe(true);
      expect(deleted?.classList.contains('lct-tree-deleted')).toBe(true);

      // Cross-check the negative: a modified file does NOT carry an added or
      // deleted class so the CSS does not compose two colour tokens.
      expect(modified?.classList.contains('lct-tree-added')).toBe(false);
      expect(modified?.classList.contains('lct-tree-deleted')).toBe(false);
    });
  });

  describe('AC3: clicking a file row emits the path and marks is-active', () => {
    it('emits the selection callback exactly once with the clicked path', (): void => {
      component.update({ entries: fixture(), rootPath: 'notes' });

      const target: HTMLElement | null = host.querySelector<HTMLElement>('[data-path="notes/sub/added.md"]');

      expect(target).not.toBeNull();
      target?.click();

      // The first file rendered (notes/direct-modified.md) is selected by
      // default on update so the diff pane has something to show; the click
      // adds the second emission for the explicitly-clicked path.
      expect(selectedPaths).toEqual(['notes/sub/added.md']);

      const active: HTMLElement | null = host.querySelector<HTMLElement>('.lct-folder-tree-file.is-active');

      expect(active?.getAttribute('data-path')).toBe('notes/sub/added.md');
    });

    it('only one row carries is-active at a time after a re-click', (): void => {
      component.update({ entries: fixture(), rootPath: 'notes' });

      const first: HTMLElement | null = host.querySelector<HTMLElement>('[data-path="notes/sub/added.md"]');
      first?.click();

      const second: HTMLElement | null = host.querySelector<HTMLElement>('[data-path="notes/sub/deleted.md"]');
      second?.click();

      const active: NodeListOf<HTMLElement> = host.querySelectorAll<HTMLElement>('.lct-folder-tree-file.is-active');

      expect(active.length).toBe(1);
      expect(active[0].getAttribute('data-path')).toBe('notes/sub/deleted.md');
    });

    it('preserves the active selection across an update when the file still exists', (): void => {
      component.update({ entries: fixture(), rootPath: 'notes' });

      const target: HTMLElement | null = host.querySelector<HTMLElement>('[data-path="notes/sub/added.md"]');
      target?.click();

      component.update({ entries: fixture(), rootPath: 'notes' });

      expect(component.getSelectedPath()).toBe('notes/sub/added.md');

      const active: HTMLElement | null = host.querySelector<HTMLElement>('.lct-folder-tree-file.is-active');
      expect(active?.getAttribute('data-path')).toBe('notes/sub/added.md');
    });
  });

  describe('AC4: folder rows collapse / expand and the state survives re-render', () => {
    it('hides the folder children after a collapse click and shows them after expand', (): void => {
      component.update({ entries: fixture(), rootPath: 'notes' });

      // sub-folder is initially expanded so both its children are visible.
      expect(host.querySelector('[data-path="notes/sub/added.md"]')).not.toBeNull();
      expect(host.querySelector('[data-path="notes/sub/deleted.md"]')).not.toBeNull();

      const folderRow: HTMLElement | null = host.querySelector<HTMLElement>('[data-path="notes/sub"]');
      folderRow?.click();

      expect(host.querySelector('[data-path="notes/sub/added.md"]')).toBeNull();
      expect(host.querySelector('[data-path="notes/sub/deleted.md"]')).toBeNull();

      const reopened: HTMLElement | null = host.querySelector<HTMLElement>('[data-path="notes/sub"]');
      reopened?.click();

      expect(host.querySelector('[data-path="notes/sub/added.md"]')).not.toBeNull();
    });

    it('keeps the collapsed state when the entries are re-applied', (): void => {
      component.update({ entries: fixture(), rootPath: 'notes' });

      const folderRow: HTMLElement | null = host.querySelector<HTMLElement>('[data-path="notes/sub"]');
      folderRow?.click();

      expect(host.querySelector('[data-path="notes/sub/added.md"]')).toBeNull();

      // A re-render with the same data must not reset the collapse state: the
      // folder modal re-runs update on every timeline-point pick, and the user
      // expects their explicit collapses to stick.
      component.update({ entries: fixture(), rootPath: 'notes' });

      expect(host.querySelector('[data-path="notes/sub/added.md"]')).toBeNull();
    });
  });

  describe('AC5: empty entries show the inline hint', () => {
    it('renders the lct-folder-tree-empty hint when no entries change', (): void => {
      component.update({ entries: [], rootPath: 'notes' });

      const empty: HTMLElement | null = host.querySelector('.lct-folder-tree-empty');

      expect(empty).not.toBeNull();
      expect(empty?.textContent ?? '').toContain('No changes');
      // No tree container is emitted when the tree is empty so the empty hint
      // is the only visible node.
      expect(host.querySelector('.lct-folder-tree')).toBeNull();
    });

    it('renders the empty hint when every entry has status none', (): void => {
      const entries: FolderTreeEntry[] = [
        { path: 'notes/a.md', status: FolderDeltaStatus.none },
        { path: 'notes/sub/b.md', status: FolderDeltaStatus.none },
      ];

      component.update({ entries, rootPath: 'notes' });

      const empty: HTMLElement | null = host.querySelector('.lct-folder-tree-empty');

      expect(empty).not.toBeNull();
    });
  });

  describe('dispose tears the component down', () => {
    it('empties the container and forgets the selection on dispose', (): void => {
      component.update({ entries: fixture(), rootPath: 'notes' });

      const before: HTMLElement | null = host.querySelector('.lct-folder-tree');
      expect(before).not.toBeNull();

      component.dispose();

      expect(host.children.length).toBe(0);
      expect(component.getSelectedPath()).toBeNull();
    });
  });
});
