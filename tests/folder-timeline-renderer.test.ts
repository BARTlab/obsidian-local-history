/** @vitest-environment jsdom */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FolderTimelinePointKind } from '@/consts';
import { FolderTimelineRenderer } from '@/modals/folder-timeline-renderer';
import type { FolderTimelineHost } from '@/modals/folder-timeline-renderer.types';
import { FileSnapshot } from '@/snapshots/file.snapshot';
import { FileVersion } from '@/snapshots/file.version';
import type LineChangeTrackerPlugin from '@/main';
import type { FolderTimelinePoint } from '@/types';
import { installJsdomDomPolyfill } from './helpers/jsdom-dom';

/**
 * Tests for {@link FolderTimelineRenderer}, the left-rail timeline
 * collaborator the folder-history modal owns. Extracted from the 1416-LOC modal,
 * where the rail grouping, the external-badge derivation, and the click-to-pin
 * were untestable; these run under jsdom and cover the behaviour the rail relies
 * on:
 *
 * - render groups the points by their day key, marks the row whose timestamp
 *   matches the selected T as active, and falls back to a no-results hint on an
 *   empty timeline,
 * - a `capture` point whose underlying version is flagged external carries the
 *   external badge, while delete / move-in markers and non-external captures do
 *   not, and
 * - clicking a row reports its timestamp back through the host's
 *   `selectTimestamp`.
 *
 * A real {@link FileSnapshot} carrying a real {@link FileVersion} backs the host
 * so the external-badge derivation runs against the genuine version flag.
 */
describe('FolderTimelineRenderer', () => {
  /**
   * jsdom does not implement HTMLElement.empty (Obsidian augments the prototype
   * at runtime). render() calls empty() to clear the rail before rebuilding it,
   * so the shared polyfill must be installed for every test.
   */
  beforeAll((): void => {
    installJsdomDomPolyfill();
  });

  let railEl: HTMLElement | undefined;
  let timeline: FolderTimelinePoint[];
  let selectedTimestamp: number;
  let snapshotsByPath: Map<string, FileSnapshot>;
  let picked: number[];

  const plugin = {
    t: (key: string): string => key,
  } as unknown as LineChangeTrackerPlugin;

  const makeHost = (): FolderTimelineHost => ({
    plugin,
    railEl: (): HTMLElement | undefined => railEl,
    timeline: (): FolderTimelinePoint[] => timeline,
    selectedTimestamp: (): number => selectedTimestamp,
    snapshotsByPath: (): Map<string, FileSnapshot> => snapshotsByPath,
    selectTimestamp: (timestamp: number): void => {
      picked.push(timestamp);
    },
  });

  beforeEach((): void => {
    railEl = document.createElement('div');
    document.body.appendChild(railEl);
    timeline = [];
    selectedTimestamp = 0;
    snapshotsByPath = new Map();
    picked = [];
  });

  it('groups by day key and marks the row matching the selected T active', () => {
    timeline = [
      { timestamp: 100, path: 'a.md', kind: FolderTimelinePointKind.capture, dayKey: 'Mon' },
      { timestamp: 90, path: 'b.md', kind: FolderTimelinePointKind.capture, dayKey: 'Mon' },
      { timestamp: 50, path: 'c.md', kind: FolderTimelinePointKind.delete, dayKey: 'Sun' },
    ];
    selectedTimestamp = 90;

    new FolderTimelineRenderer(makeHost()).render();

    const dayHeaders = (railEl as HTMLElement).querySelectorAll('.lct-versions-day');

    expect(dayHeaders.length).toBe(2);
    expect(dayHeaders[0].textContent).toBe('Mon');
    expect(dayHeaders[1].textContent).toBe('Sun');

    const items = (railEl as HTMLElement).querySelectorAll('.lct-version-item');

    expect(items.length).toBe(3);
    // The second point (timestamp 90) is the selected one.
    expect(items[1].classList.contains('is-active')).toBe(true);
    expect(items[0].classList.contains('is-active')).toBe(false);
  });

  it('replaces the rail on re-render instead of stacking a second copy', () => {
    timeline = [
      { timestamp: 100, path: 'a.md', kind: FolderTimelinePointKind.capture, dayKey: 'Mon' },
      { timestamp: 90, path: 'b.md', kind: FolderTimelinePointKind.capture, dayKey: 'Mon' },
      { timestamp: 50, path: 'c.md', kind: FolderTimelinePointKind.delete, dayKey: 'Sun' },
    ];

    const renderer = new FolderTimelineRenderer(makeHost());

    // render() runs on every T change (each rail click re-pins T). Three renders
    // must leave exactly one rail, not three stacked day-block copies.
    renderer.render();
    renderer.render();
    renderer.render();

    const rail = railEl as HTMLElement;

    expect(rail.querySelectorAll('.lct-versions').length).toBe(1);
    expect(rail.querySelectorAll('.lct-versions-day').length).toBe(2);
    expect(rail.querySelectorAll('.lct-version-item').length).toBe(3);
  });

  it('renders a no-results hint on an empty timeline', () => {
    timeline = [];

    new FolderTimelineRenderer(makeHost()).render();

    expect((railEl as HTMLElement).querySelector('.lct-versions-no-results')).not.toBeNull();
    expect((railEl as HTMLElement).querySelectorAll('.lct-version-item').length).toBe(0);
  });

  it('paints the external badge only on a capture point whose version is flagged external', () => {
    const external = new FileVersion(['x'], 100, undefined, true);
    const snapshot = new FileSnapshot('x');

    snapshot.timeline.adopt([external]);
    snapshotsByPath.set('a.md', snapshot);

    timeline = [
      { timestamp: 100, path: 'a.md', kind: FolderTimelinePointKind.capture, dayKey: 'Mon', versionId: external.id },
    ];

    new FolderTimelineRenderer(makeHost()).render();

    expect((railEl as HTMLElement).querySelector('.lct-version-item .lct-version-external-badge')).not.toBeNull();
  });

  it('does not paint the badge for a non-external capture or a delete marker', () => {
    const local = new FileVersion(['x'], 100, undefined, false);
    const snapshot = new FileSnapshot('x');

    snapshot.timeline.adopt([local]);
    snapshotsByPath.set('a.md', snapshot);

    timeline = [
      { timestamp: 100, path: 'a.md', kind: FolderTimelinePointKind.capture, dayKey: 'Mon', versionId: local.id },
      { timestamp: 50, path: 'b.md', kind: FolderTimelinePointKind.delete, dayKey: 'Mon' },
    ];

    new FolderTimelineRenderer(makeHost()).render();

    expect((railEl as HTMLElement).querySelector('.lct-version-external-badge')).toBeNull();
  });

  it('reports the clicked row timestamp back through the host', () => {
    timeline = [
      { timestamp: 100, path: 'a.md', kind: FolderTimelinePointKind.capture, dayKey: 'Mon' },
      { timestamp: 90, path: 'b.md', kind: FolderTimelinePointKind.capture, dayKey: 'Mon' },
    ];

    new FolderTimelineRenderer(makeHost()).render();

    const items = (railEl as HTMLElement).querySelectorAll<HTMLElement>('.lct-version-item');

    items[1].click();

    expect(picked).toEqual([90]);
  });

  it('is a no-op when the rail container is absent', () => {
    railEl = undefined;
    timeline = [{ timestamp: 100, path: 'a.md', kind: FolderTimelinePointKind.capture, dayKey: 'Mon' }];

    expect((): void => new FolderTimelineRenderer(makeHost()).render()).not.toThrow();
    expect(picked).toEqual([]);
  });

  describe('isExternalPoint', () => {
    it('returns false for a capture whose version is no longer in the map', () => {
      timeline = [];
      const renderer = new FolderTimelineRenderer(makeHost());

      const point: FolderTimelinePoint = {
        timestamp: 100,
        path: 'missing.md',
        kind: FolderTimelinePointKind.capture,
        dayKey: 'Mon',
        versionId: 'gone',
      };

      expect(renderer.isExternalPoint(point)).toBe(false);
    });

    it('returns false for a move-in marker even with a snapshot present', () => {
      const snapshot = new FileSnapshot('x');

      snapshotsByPath.set('a.md', snapshot);
      const renderer = new FolderTimelineRenderer(makeHost());

      const point: FolderTimelinePoint = {
        timestamp: 100,
        path: 'a.md',
        kind: FolderTimelinePointKind.moveIn,
        dayKey: 'Mon',
      };

      expect(renderer.isExternalPoint(point)).toBe(false);
    });
  });
});
