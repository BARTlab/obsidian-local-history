import { FolderTimelinePointKind } from '@/consts';
import { DomHelper } from '@/helpers/dom.helper';
import { ExternalBadgeHelper } from '@/helpers/external-badge.helper';
import type LineChangeTrackerPlugin from '@/main';
import type { FileSnapshot } from '@/snapshots/file.snapshot';
import type { FileVersion } from '@/snapshots/file.version';
import type { DomElementConfig, FolderTimelinePoint } from '@/types';

/**
 * Host port the {@link FolderTimelineRenderer} reads its shared modal state
 * through. The renderer owns the rail rendering but stays stateless about the
 * modal: it reads the live timeline, the selected timeline point T, the rail
 * container, and the snapshot map back through this port, and reports a new T
 * via {@link selectTimestamp} so the host re-pins it and re-renders the tree
 * and diff.
 */
export interface FolderTimelineHost {
  /**
   * The plugin instance, used only for translation lookups.
   */
  readonly plugin: LineChangeTrackerPlugin;

  /**
   * Left rail container the timeline renders into, or `undefined` before the
   * shell is built. The renderer is a no-op when it is absent.
   *
   * @return {HTMLElement | undefined} The rail container, or undefined
   */
  railEl(): HTMLElement | undefined;

  /**
   * The timeline points to render, newest-first, grouped by day key.
   *
   * @return {FolderTimelinePoint[]} The timeline points
   */
  timeline(): FolderTimelinePoint[];

  /**
   * The currently selected timeline point T in ms, used to mark the active row.
   *
   * @return {number} The selected T
   */
  selectedTimestamp(): number;

  /**
   * The snapshot map keyed by path, used to resolve a capture point back to its
   * version when deciding whether the row carries an external badge.
   *
   * @return {Map<string, FileSnapshot>} The snapshot map
   */
  snapshotsByPath(): Map<string, FileSnapshot>;

  /**
   * Pins a new timeline point T. The host updates its selected T, re-renders the
   * rail, re-colours the tree, and refreshes the diff. A no-op on the host side
   * when T is already selected.
   *
   * @param {number} timestamp - The new selected T
   */
  selectTimestamp(timestamp: number): void;
}

/**
 * Timeline-rail collaborator for the folder-history modal.
 *
 * Extracted from {@link FolderHistoryModal} as a plain object the modal
 * instantiates and owns (per ADR-11: deep collaborators, not DI
 * services). It owns the left rail: grouping the timeline points by day,
 * rendering the grouped, clickable rows with their external badges (via the
 * shared {@link ExternalBadgeHelper}), and the per-row label / kind /
 * external derivation. It is stateless about the modal and reads the live
 * timeline, the selected T, and the snapshot map back through
 * {@link FolderTimelineHost}, reporting a new T via the host's
 * `selectTimestamp` so the modal keeps coordinating the tree and diff.
 */
export class FolderTimelineRenderer {
  /**
   * @param {FolderTimelineHost} host - The modal port the renderer reads its
   *   shared state through and reports the picked T to.
   */
  public constructor(protected readonly host: FolderTimelineHost) {}

  /**
   * Renders the timeline rail: a flat list of points grouped by their day
   * key, clickable so the user can pick a new T. Highlights the entry whose
   * timestamp matches the currently selected T.
   */
  public render(): void {
    const railEl: HTMLElement | undefined = this.host.railEl();

    if (!railEl) {
      return;
    }

    type RailGroup = { label: string; points: FolderTimelinePoint[] };

    const groups: RailGroup[] = [];

    this.host.timeline().forEach((point: FolderTimelinePoint): void => {
      let group: RailGroup | undefined = groups[groups.length - 1];

      if (!group || group.label !== point.dayKey) {
        group = { label: point.dayKey, points: [] };
        groups.push(group);
      }

      group.points.push(point);
    });

    const items: DomElementConfig[] = [];

    groups.forEach((group: RailGroup): void => {
      items.push({ tag: 'div', classes: 'lct-versions-day', text: group.label });

      group.points.forEach((point: FolderTimelinePoint): void => {
        items.push(this.makeTimelineItem(point));
      });
    });

    if (items.length === 0) {
      /**
       * Defensive: openFolderHistory rejects an empty subtree, but a future
       * caller might bypass that gate, so the rail still has a sensible
       * no-results hint instead of an empty column.
       */
      items.push({
        tag: 'div',
        classes: 'lct-versions-no-results',
        text: this.host.plugin.t('modal.no-versions-match'),
      });
    }

    DomHelper.update(railEl, {
      children: [
        {
          tag: 'div',
          classes: 'lct-versions',
          children: [{ tag: 'div', classes: 'lct-versions-list', children: items }],
        },
      ],
    });

    ExternalBadgeHelper.paint(railEl);
  }

  /**
   * Whether the given timeline point comes from an external-change capture
   *. Only `'capture'` points map back to a `FileVersion` via
   * `versionId`; `'delete'` and `'move-in'` markers stay non-external. A
   * point whose path or version is no longer in the map (e.g. removed by a
   * destructive action after resync) returns false defensively.
   *
   * @param {FolderTimelinePoint} point - The timeline point to inspect
   * @return {boolean} True when the underlying version is flagged external
   */
  public isExternalPoint(point: FolderTimelinePoint): boolean {
    if (point.kind !== FolderTimelinePointKind.capture || !point.versionId) {
      return false;
    }

    const snapshot: FileSnapshot | undefined = this.host.snapshotsByPath().get(point.path);

    if (!snapshot) {
      return false;
    }

    const version: FileVersion | undefined = snapshot.getVersion(point.versionId) ?? undefined;

    return version?.isExternal() === true;
  }

  /**
   * Builds a single timeline rail entry: a label describing the event (a
   * capture / delete / move-in plus the file's short name), the time of day
   * inline, and a click that re-pins T and re-renders the tree and diff.
   *
   * @param {FolderTimelinePoint} point - The point to render
   * @return {DomElementConfig} The rail entry element config
   */
  protected makeTimelineItem(point: FolderTimelinePoint): DomElementConfig {
    const active: boolean = this.host.selectedTimestamp() === point.timestamp;
    const shortName: string = this.basename(point.path);
    const kindLabel: string = this.kindLabel(point.kind);
    const time: string = new Date(point.timestamp).toLocaleTimeString();
    const external: boolean = this.isExternalPoint(point);

    const labelChildren: DomElementConfig[] = [
      { tag: 'span', classes: 'lct-version-label', text: shortName },
    ];

    if (external) {
      labelChildren.push(ExternalBadgeHelper.make(this.host.plugin.t('version.badge.external')));
    }

    return {
      tag: 'div',
      classes: active ? ['lct-version-item', 'is-active'] : ['lct-version-item'],
      events: {
        click: (): void => {
          this.host.selectTimestamp(point.timestamp);
        },
      },
      children: [
        { tag: 'span', classes: 'lct-version-label-row', children: labelChildren },
        { tag: 'span', classes: 'lct-version-meta', text: `${kindLabel}, ${time}` },
      ],
    };
  }

  /**
   * Returns a short, inline-English label for a timeline point kind. The
   * literal strings are propagated across every catalog;
   * until then, the labels show as English on every locale.
   *
   * @param {FolderTimelinePoint['kind']} kind - The discriminator
   * @return {string} The human-readable kind label
   */
  protected kindLabel(kind: FolderTimelinePoint['kind']): string {
    const keyByKind: Record<FolderTimelinePointKind, string> = {
      [FolderTimelinePointKind.capture]: 'modal.folder.timeline.capture',
      [FolderTimelinePointKind.delete]: 'modal.folder.timeline.delete',
      [FolderTimelinePointKind.moveIn]: 'modal.folder.timeline.move-in',
    };

    return this.host.plugin.t(keyByKind[kind]);
  }

  /**
   * Returns the last path segment of a vault-relative path. Used as the rail
   * row's short file label so the column does not overflow on deep paths.
   *
   * @param {string} path - The vault-relative path
   * @return {string} The trailing segment, or the path itself when no slash
   */
  protected basename(path: string): string {
    const lastSlash: number = path.lastIndexOf('/');

    return lastSlash === -1 ? path : path.slice(lastSlash + 1);
  }
}
