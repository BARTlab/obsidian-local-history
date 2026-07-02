import type { RailEntry, VersionListHost } from '@/components/version-list.component.types';
import { ORIGINAL_BASE_ID, VersionListEdge } from '@/consts';
import type { ListSelectionDirection } from '@/consts';
import * as ExternalBadgeHelper from '@/helpers/external-badge.helper';
import * as ListSelectionHelper from '@/helpers/list-selection.helper';
import * as DomHelper from '@/helpers/dom.helper';
import * as VersionLabelHelper from '@/helpers/version-label.helper';
import * as VersionSearchHelper from '@/helpers/version-search.helper';
import type { FileSnapshot } from '@/snapshots/file.snapshot';
import type { FileVersion } from '@/snapshots/file.version';
import type { DomElementConfig, SearchableVersion, VersionDescription } from '@/types';

/**
 * Version-list collaborator for the history modal.
 *
 * Extracted from {@link HistoryModal} as a plain object the modal instantiates
 * and owns (per ADR-11: deep collaborators, not DI services). It owns
 * the left-rail timeline: building the visible version set (search +
 * hide-identical + selection filters), rendering the grouped, selectable rows
 * with their external badges, walking the selection with the keyboard, and
 * scrolling the active row into view. It is stateless about the modal and reads
 * the live selection and filter flags back through {@link VersionListHost},
 * reporting a selection change via the host's `selectBase` so the modal keeps
 * coordinating the diff render. The label/delta derivation is public so the
 * modal's side-by-side column header can reuse the same primary-label rule.
 */
export class VersionList {
  /**
   * @param {VersionListHost} host - The modal port the component reads its
   *   shared state through and reports selection changes to.
   */
  public constructor(protected readonly host: VersionListHost) {}

  /**
   * The intermediate versions currently shown in the rail, newest first, after
   * the content search and the hide-identical filter. The hide-identical filter
   * drops versions whose captured content equals the live state (picking one
   * would diff to nothing); the search keeps only versions matching the query.
   * Shared by the rail render and the post-delete selection so "the next visible
   * version" means the same list in both.
   *
   * @return {FileVersion[]} The visible versions, newest first
   */
  public getVisibleVersions(): FileVersion[] {
    const snapshot: FileSnapshot = this.host.snapshot;
    const versions: FileVersion[] = snapshot.timeline.getVersions();

    const visibleIds: Set<string> = VersionSearchHelper.match(
      versions.map((version: FileVersion): SearchableVersion => ({
        id: version.id,
        content: version.getContent(snapshot.content.lineBreak),
      })),
      this.host.searchQuery(),
    );

    const currentContent: string = snapshot.content.getLastState();

    const selectionIds: ReadonlySet<string> | undefined = this.host.selectionFilterIds();

    return versions.filter((version: FileVersion): boolean => {
      if (!visibleIds.has(version.id)) {
        return false;
      }

      /**
       * When a selection filter is active the rail only shows versions
       * whose neighbour-diff touched the selection. An empty set means the
       * filter is active but matched nothing, so the rail collapses to its
       * no-results hint without us short-circuiting the visibility logic.
       */
      if (selectionIds !== undefined && !selectionIds.has(version.id)) {
        return false;
      }

      return !this.host.hideIdenticalVersions() || version.getContent(snapshot.content.lineBreak) !== currentContent;
    });
  }

  /**
   * The ids selectable in the rail, in rendered order. With captured snapshots
   * these are the currently visible versions (after the search and
   * hide-identical filters) newest-first; with no snapshots it is the single
   * Original entry. This is the list the arrow keys walk.
   *
   * @return {string[]} The selectable base ids, top to bottom
   */
  public getSelectableIds(): string[] {
    if (this.host.snapshot.timeline.getVersions().length === 0) {
      return [ORIGINAL_BASE_ID];
    }

    return this.getVisibleVersions().map((version: FileVersion): string => version.id);
  }

  /**
   * Moves the rail selection one entry up or down and keeps it in view. The
   * order matches the rendered list (the baseline on top, then the visible
   * versions newest-first), so down moves toward older snapshots. The walk is
   * delegated to the pure ListSelectionHelper and clamps at both ends. A move
   * that resolves to the already-selected entry (an edge) is a no-op.
   *
   * @param {ListSelectionDirection} direction - Which way to move the selection
   */
  public moveSelection(direction: ListSelectionDirection): void {
    const current: string = this.host.selectedBaseId();
    const next: string | null = ListSelectionHelper.step(this.getSelectableIds(), current, direction);

    if (next === null || next === current) {
      return;
    }

    this.host.selectBase(next);
    this.scrollActiveIntoView();
  }

  /**
   * Jumps the rail selection to the first (baseline) or last (oldest visible
   * version) entry, backing the Home/End keys. A no-op when that edge is already
   * selected or the list is empty.
   *
   * @param {VersionListEdge} edge - Which end of the list to select
   */
  public moveSelectionToEdge(edge: VersionListEdge): void {
    const ids: string[] = this.getSelectableIds();
    const target: string | undefined = edge === VersionListEdge.first ? ids[0] : ids[ids.length - 1];

    if (!target || target === this.host.selectedBaseId()) {
      return;
    }

    this.host.selectBase(target);
    this.scrollActiveIntoView();
  }

  /**
   * Scrolls the currently selected version entry into view inside the rail, so
   * an arrow-key move that lands on an off-screen snapshot brings it into sight.
   */
  public scrollActiveIntoView(): void {
    this.host
      .versionsEl()
      ?.querySelector<HTMLElement>('.lct-version-item.is-active')
      ?.scrollIntoView({ block: 'nearest' });
  }

  /**
   * Returns the primary label shown for a captured version: the user's custom
   * label when present, otherwise the derived action text translated from
   * VersionLabelHelper.describe against the version's previous neighbour. For
   * the oldest version on the timeline the previous neighbour is the history
   * baseline.
   *
   * @param {FileVersion} version - The version to label
   * @param {FileVersion[]} versions - The full timeline, newest first
   * @return {string} The primary label string
   */
  public resolvePrimaryLabel(version: FileVersion, versions: FileVersion[]): string {
    if (version.isLabeled()) {
      return version.label as string;
    }

    const description: VersionDescription = this.describe(version, versions);

    return this.host.plugin.t(`modal.version.action.${description.kind}`);
  }

  /**
   * Computes the derived action description for a version against its previous
   * neighbour. The neighbour is the next-older captured version, or the file's
   * history baseline when the version is the oldest one on the timeline. The
   * result drives both the rail primary label (when no custom label is set) and
   * the inline line delta shown on the row.
   *
   * @param {FileVersion} version - The version to describe
   * @param {FileVersion[]} versions - The full timeline, newest first
   * @return {VersionDescription} The action kind plus the added/removed counts
   */
  public describe(version: FileVersion, versions: FileVersion[]): VersionDescription {
    const historyLines: string[] = this.host.snapshot.content.getHistoryOriginalStateLines();

    return VersionLabelHelper.walkNeighbour(version, versions, historyLines);
  }

  /**
   * Formats the inline line delta shown on a rail row. Returns an empty string
   * when both added and removed are zero so the row stays clean for no-op
   * captures (e.g. a labeled version pinned at unchanged content).
   *
   * @param {VersionDescription} description - The describe result
   * @return {string} The formatted delta or empty string
   */
  public formatDelta(description: VersionDescription): string {
    return VersionLabelHelper.formatDelta(description, this.host.plugin.t.bind(this.host.plugin));
  }

  /**
   * Renders the version timeline as a list of selectable diff bases, grouped
   * under a heading per day. With captured snapshots the list is the real
   * versions, newest first, each in its capture day's group; the topmost
   * (the latest snapshot) is the default base and shows what changed since the
   * last save. With no snapshots yet the list is a single Original entry (the
   * file's birth state vs the current content), placed in the day group of the
   * file's last update. The rail is never hidden: when a query matches no
   * version it shows just a no-results hint, leaving the current selection
   * untouched. Selecting an entry sets it as the diff base and re-renders the
   * active view.
   */
  public render(): void {
    const versionsEl: HTMLElement | undefined = this.host.versionsEl();

    if (!versionsEl) {
      return;
    }

    const snapshot: FileSnapshot = this.host.snapshot;
    const versions: FileVersion[] = snapshot.timeline.getVersions();

    /**
     * The rail is always visible: even a timeline-less file offers the single
     * Original entry (original vs current), so the block is never collapsed.
     */
    DomHelper.update(versionsEl, { classes: { remove: 'lct-versions-empty' } });

    const matched: FileVersion[] = this.getVisibleVersions();

    /**
     * Each entry is grouped by day; the row shows the action (or the user's
     * custom label) as the primary text, with the capture date+time and the
     * line-level delta inline as secondary metadata (the date is duplicated on
     * the row, not only in the group heading, so the AC is met without relying
     * on hover or external context). With snapshots the entries are the visible
     * versions, already newest-first and time-ordered, so same-day entries are
     * contiguous and a new group starts only when the day changes. With no
     * snapshots the single Original entry takes its day and time from the
     * file's last update and has no inline delta.
     */
    const entries: RailEntry[] =
      versions.length === 0
        ? [
            {
              id: ORIGINAL_BASE_ID,
              label: this.host.plugin.t('modal.version.original'),
              day: snapshot.getLastChangedDate(),
              meta: snapshot.getLastChangedDateTime(),
              delta: '',
              external: false,
            },
          ]
        : matched.map((version: FileVersion): RailEntry => {
            const description: VersionDescription = this.describe(version, versions);

            return {
              id: version.id,
              label: this.resolvePrimaryLabel(version, versions),
              day: version.getDate(),
              meta: version.getDateTime(),
              delta: this.formatDelta(description),
              external: version.isExternal(),
            };
          });

    const groups: { label: string; entries: RailEntry[] }[] = [];

    entries.forEach((entry: RailEntry): void => {
      let group: { label: string; entries: RailEntry[] } | undefined = groups[groups.length - 1];

      if (!group || group.label !== entry.day) {
        group = { label: entry.day, entries: [] };
        groups.push(group);
      }

      group.entries.push(entry);
    });

    const items: DomElementConfig[] = [];

    groups.forEach((group: { label: string; entries: RailEntry[] }): void => {
      items.push({ tag: 'div', classes: 'lct-versions-day', text: group.label });
      group.entries.forEach((entry: RailEntry): void => {
        items.push(this.makeItem(entry));
      });
    });

    /**
     * A search that excluded every captured version leaves the version groups
     * empty, so surface a no-results hint. (With no snapshots at all the
     * Original entry is shown instead, so this only applies once versions
     * exist.)
     */
    if (versions.length > 0 && matched.length === 0) {
      items.push({
        tag: 'div',
        classes: 'lct-versions-no-results',
        text: this.host.plugin.t('modal.no-versions-match'),
      });
    }

    DomHelper.update(versionsEl, {
      children: [
        {
          tag: 'div',
          classes: 'lct-versions-list',
          children: items,
        },
      ],
    });

    ExternalBadgeHelper.paint(versionsEl);
  }

  /**
   * Builds a single selectable version list entry config.
   * The active entry carries a highlight class; clicking selects that base. A
   * version captured from an external change renders a small badge
   * next to the primary label so the user can tell external states apart from
   * editor edits without opening the diff.
   *
   * @param {RailEntry} entry - The rail entry to render
   * @return {DomElementConfig} A DomHelper element config for the entry
   */
  protected makeItem(entry: RailEntry): DomElementConfig {
    const active: boolean = this.host.selectedBaseId() === entry.id;
    const labelChildren: DomElementConfig[] = [
      { tag: 'span', classes: 'lct-version-label', text: entry.label },
    ];

    if (entry.external) {
      labelChildren.push(ExternalBadgeHelper.make(this.host.plugin.t('version.badge.external')));
    }

    const children: DomElementConfig[] = [
      { tag: 'span', classes: 'lct-version-label-row', children: labelChildren },
    ];

    if (entry.meta) {
      children.push({ tag: 'span', classes: 'lct-version-meta', text: entry.meta });
    }

    if (entry.delta) {
      children.push({ tag: 'span', classes: 'lct-version-delta', text: entry.delta });
    }

    return {
      tag: 'div',
      classes: active ? ['lct-version-item', 'is-active'] : ['lct-version-item'],
      events: {
        click: (): void => {
          this.host.selectBase(entry.id);
        },
      },
      children,
    };
  }
}
