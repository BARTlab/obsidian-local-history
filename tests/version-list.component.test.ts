/** @jest-environment jsdom */

import { beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { ListSelectionDirection, ORIGINAL_BASE_ID, VersionAction, VersionListEdge } from '@/consts';
import { VersionList } from '@/components/version-list.component';
import type { VersionListHost } from '@/components/version-list.component';
import { FileSnapshot } from '@/snapshots/file.snapshot';
import { FileVersion } from '@/snapshots/file.version';
import type LineChangeTrackerPlugin from '@/main';

/**
 * Tests for {@link VersionList}, the left-rail version-list collaborator
 * the history modal owns. Extracted from the 2246-LOC modal, where the visible
 * set, the keyboard selection, the label/delta derivation, and the rail render
 * were untestable; these run under jsdom and cover the behaviour the rail
 * relies on:
 *
 * - the visible set applies the content search and the hide-identical filter,
 * - the selectable ids fall back to the single Original entry with no snapshots,
 * - the keyboard selection walks the rendered order (newest first), clamps at
 *   the ends, and Home/End jump to the edges,
 * - the primary label is the custom label when set, else the derived action,
 *   and the delta is empty for a no-op,
 * - render groups by day, marks the active row, paints the external badge, and
 *   shows the no-results hint when a search excludes every version, and
 * - a click on a row reports the base back through the host.
 *
 * A real {@link FileSnapshot} backs the host so the visible-set logic runs
 * against the genuine timeline, not a mock that could drift from it.
 */
describe('VersionList', () => {
  /**
   * jsdom does not implement scrollIntoView; the keyboard move calls it on the
   * active row, so a no-op stub keeps the move observable without throwing.
   */
  beforeAll((): void => {
    (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = (): void => {
      // no-op under jsdom
    };
  });

  /** Records the bases the host was asked to select, in order. */
  let selected: string[];
  /** The current selected base id the host reports back. */
  let selectedBaseId: string;
  /** The live content-search query. */
  let searchQuery: string;
  /** Whether the rail hides identical versions. */
  let hideIdentical: boolean;
  /** The optional selection filter ids. */
  let selectionFilterIds: ReadonlySet<string> | undefined;
  /** The rail container the render writes into. */
  let versionsEl: HTMLElement;

  /**
   * Stub plugin whose `t` echoes the key (with the modified-delta key spelled
   * out so the formatted-delta assertion can see the added/removed counts). The
   * rail never depends on the real catalog, only on the lookup being callable.
   */
  const plugin = {
    t: (key: string, vars?: Record<string, string>): string =>
      vars ? `${key}:${vars.added}/${vars.removed}` : key,
  } as unknown as LineChangeTrackerPlugin;

  /**
   * Builds a snapshot whose current state is `current` and whose timeline is the
   * given version lines, oldest first (the order the snapshot stores them in, so
   * the rail renders them newest first).
   *
   * @param {string[]} current - The current document state lines
   * @param {FileVersion[]} versionsOldestFirst - Timeline versions, oldest first
   * @return {FileSnapshot} The populated snapshot
   */
  const makeSnapshot = (current: string[], versionsOldestFirst: FileVersion[]): FileSnapshot => {
    const snapshot = new FileSnapshot(current.join('\n'));

    snapshot.versions = versionsOldestFirst;

    return snapshot;
  };

  /**
   * Builds the host port over the mutable test state, mirroring the modal's
   * makeVersionListHost.
   *
   * @param {FileSnapshot} snapshot - The snapshot the rail lists
   * @return {VersionListHost} The host port
   */
  const makeHost = (snapshot: FileSnapshot): VersionListHost => ({
    snapshot,
    plugin,
    versionsEl: (): HTMLElement | undefined => versionsEl,
    selectedBaseId: (): string => selectedBaseId,
    searchQuery: (): string => searchQuery,
    hideIdenticalVersions: (): boolean => hideIdentical,
    selectionFilterIds: (): ReadonlySet<string> | undefined => selectionFilterIds,
    selectBase: (id: string): void => {
      selected.push(id);
      selectedBaseId = id;
    },
  });

  beforeEach((): void => {
    selected = [];
    selectedBaseId = ORIGINAL_BASE_ID;
    searchQuery = '';
    hideIdentical = false;
    selectionFilterIds = undefined;
    versionsEl = document.createElement('div');
    document.body.appendChild(versionsEl);
  });

  describe('getVisibleVersions', () => {
    it('returns every version newest first when no filter is active', () => {
      const v1 = new FileVersion(['alpha'], 1);
      const v2 = new FileVersion(['beta'], 2);
      const list = new VersionList(makeHost(makeSnapshot(['current'], [v1, v2])));

      expect(list.getVisibleVersions().map((v: FileVersion): string => v.id)).toEqual([v2.id, v1.id]);
    });

    it('keeps only versions whose content matches the search query', () => {
      const v1 = new FileVersion(['alpha needle'], 1);
      const v2 = new FileVersion(['beta'], 2);
      searchQuery = 'needle';
      const list = new VersionList(makeHost(makeSnapshot(['current'], [v1, v2])));

      expect(list.getVisibleVersions().map((v: FileVersion): string => v.id)).toEqual([v1.id]);
    });

    it('drops versions identical to the current state when hide-identical is on', () => {
      const v1 = new FileVersion(['old'], 1);
      const v2 = new FileVersion(['current'], 2);
      hideIdentical = true;
      const list = new VersionList(makeHost(makeSnapshot(['current'], [v1, v2])));

      // v2 equals the live state, so picking it would diff to nothing: hidden.
      expect(list.getVisibleVersions().map((v: FileVersion): string => v.id)).toEqual([v1.id]);
    });

    it('narrows to the selection filter set when one is active', () => {
      const v1 = new FileVersion(['alpha'], 1);
      const v2 = new FileVersion(['beta'], 2);
      const v3 = new FileVersion(['gamma'], 3);
      selectionFilterIds = new Set([v1.id, v3.id]);
      const list = new VersionList(makeHost(makeSnapshot(['current'], [v1, v2, v3])));

      expect(list.getVisibleVersions().map((v: FileVersion): string => v.id)).toEqual([v3.id, v1.id]);
    });
  });

  describe('getSelectableIds', () => {
    it('is the single Original entry with no snapshots', () => {
      const list = new VersionList(makeHost(makeSnapshot(['current'], [])));

      expect(list.getSelectableIds()).toEqual([ORIGINAL_BASE_ID]);
    });

    it('is the visible version ids newest first with snapshots', () => {
      const v1 = new FileVersion(['alpha'], 1);
      const v2 = new FileVersion(['beta'], 2);
      const list = new VersionList(makeHost(makeSnapshot(['current'], [v1, v2])));

      expect(list.getSelectableIds()).toEqual([v2.id, v1.id]);
    });
  });

  describe('keyboard selection', () => {
    it('moves the selection down toward older snapshots and reports it', () => {
      const v1 = new FileVersion(['alpha'], 1);
      const v2 = new FileVersion(['beta'], 2);
      const list = new VersionList(makeHost(makeSnapshot(['current'], [v1, v2])));

      selectedBaseId = v2.id;
      list.moveSelection(ListSelectionDirection.down);

      expect(selected).toEqual([v1.id]);
    });

    it('clamps at the bottom edge as a no-op', () => {
      const v1 = new FileVersion(['alpha'], 1);
      const v2 = new FileVersion(['beta'], 2);
      const list = new VersionList(makeHost(makeSnapshot(['current'], [v1, v2])));

      selectedBaseId = v1.id;
      list.moveSelection(ListSelectionDirection.down);

      expect(selected).toEqual([]);
    });

    it('jumps to the first and last entries on the edge keys', () => {
      const v1 = new FileVersion(['alpha'], 1);
      const v2 = new FileVersion(['beta'], 2);
      const v3 = new FileVersion(['gamma'], 3);
      const list = new VersionList(makeHost(makeSnapshot(['current'], [v1, v2, v3])));

      selectedBaseId = v2.id;
      list.moveSelectionToEdge(VersionListEdge.first);
      expect(selected).toEqual([v3.id]);

      selectedBaseId = v2.id;
      list.moveSelectionToEdge(VersionListEdge.last);
      expect(selected).toEqual([v3.id, v1.id]);
    });
  });

  describe('label and delta derivation', () => {
    it('uses the custom label when the version is labeled', () => {
      const labeled = new FileVersion(['x'], 1, 'My checkpoint');
      const list = new VersionList(makeHost(makeSnapshot(['current'], [labeled])));

      expect(list.resolvePrimaryLabel(labeled, list.getVisibleVersions())).toBe('My checkpoint');
    });

    it('derives a created action when the oldest version grows from an empty baseline', () => {
      const version = new FileVersion(['a', 'b'], 1);
      const snapshot = makeSnapshot(['current'], [version]);

      // The oldest version diffs against the history baseline; an empty baseline
      // growing into content reads as a "created" action.
      snapshot.adoptHistory([], [version]);
      const list = new VersionList(makeHost(snapshot));

      expect(list.resolvePrimaryLabel(version, list.getVisibleVersions())).toBe(
        `modal.version.action.${VersionAction.created}`,
      );
    });

    it('derives a modified action when the oldest version changes a non-empty baseline', () => {
      const version = new FileVersion(['a', 'b'], 1);
      const snapshot = makeSnapshot(['current'], [version]);

      // The baseline ('current') is non-empty and the version differs from it,
      // so the change reads as a "modified" action.
      const list = new VersionList(makeHost(snapshot));

      expect(list.resolvePrimaryLabel(version, list.getVisibleVersions())).toBe(
        `modal.version.action.${VersionAction.modified}`,
      );
    });

    it('formats a non-zero delta and returns empty for a no-op', () => {
      const list = new VersionList(makeHost(makeSnapshot(['current'], [])));

      expect(list.formatDelta({ kind: VersionAction.modified, added: 2, removed: 1 })).toBe(
        'modal.version.delta:2/1',
      );
      expect(list.formatDelta({ kind: VersionAction.modified, added: 0, removed: 0 })).toBe('');
    });
  });

  describe('render', () => {
    it('renders one selectable row per visible version, grouped under a day heading', () => {
      const v1 = new FileVersion(['alpha'], 1);
      const v2 = new FileVersion(['beta'], 2);
      const list = new VersionList(makeHost(makeSnapshot(['current'], [v1, v2])));

      list.render();

      const rows = versionsEl.querySelectorAll<HTMLElement>('.lct-version-item');

      expect(rows).toHaveLength(2);
      expect(versionsEl.querySelectorAll('.lct-versions-day').length).toBeGreaterThanOrEqual(1);
    });

    it('marks the row for the selected base as active', () => {
      const v1 = new FileVersion(['alpha'], 1);
      const v2 = new FileVersion(['beta'], 2);
      selectedBaseId = v1.id;
      const list = new VersionList(makeHost(makeSnapshot(['current'], [v1, v2])));

      list.render();

      const activeRows = versionsEl.querySelectorAll<HTMLElement>('.lct-version-item.is-active');

      expect(activeRows).toHaveLength(1);
    });

    it('renders an external badge for a version captured from an external change', () => {
      const external = new FileVersion(['alpha'], 1, undefined, true);
      const list = new VersionList(makeHost(makeSnapshot(['current'], [external])));

      list.render();

      expect(versionsEl.querySelectorAll('.lct-version-external-badge')).toHaveLength(1);
    });

    it('shows the no-results hint when a search excludes every version', () => {
      const v1 = new FileVersion(['alpha'], 1);
      searchQuery = 'zzz-no-match';
      const list = new VersionList(makeHost(makeSnapshot(['current'], [v1])));

      list.render();

      expect(versionsEl.querySelector('.lct-versions-no-results')).not.toBeNull();
      expect(versionsEl.querySelectorAll('.lct-version-item')).toHaveLength(0);
    });

    it('renders the single Original entry when there are no snapshots', () => {
      const list = new VersionList(makeHost(makeSnapshot(['current'], [])));

      list.render();

      const rows = versionsEl.querySelectorAll<HTMLElement>('.lct-version-item');

      expect(rows).toHaveLength(1);
      expect(rows[0].textContent).toContain('modal.version.original');
    });

    it('reports the clicked base back through the host', () => {
      const v1 = new FileVersion(['alpha'], 1);
      const list = new VersionList(makeHost(makeSnapshot(['current'], [v1])));

      list.render();
      versionsEl.querySelector<HTMLElement>('.lct-version-item')?.click();

      expect(selected).toEqual([v1.id]);
    });
  });
});
