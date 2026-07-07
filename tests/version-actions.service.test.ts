import 'reflect-metadata';
import { describe, expect, it, vi, type Mock } from 'vitest';

import { FileSnapshot } from '@/snapshots/file.snapshot';
import { FileVersion } from '@/snapshots/file.version';
import { VersionActionsService } from '@/services/version-actions.service';
import { TOKENS } from '@/services/tokens';
import type { TFile } from 'obsidian';

import { makeFile } from './helpers/builders';

interface ServiceHarness {
  service: VersionActionsService;
  applyContent: Mock;
  forceUpdate: Mock;
  snapshot: FileSnapshot | null;
}

/**
 * Builds a real FileSnapshot over the given file, seeding its current state (and
 * therefore the history baseline) from the joined lines. The timeline is left
 * empty; callers seed versions through the genuine API (timeline.adopt or the
 * service's own captureVersion path) so the assertions exercise the real class
 * rather than a hand-rolled double.
 */
const makeSnapshot = (file: TFile, state: string[]): FileSnapshot =>
  new FileSnapshot(state.join('\n'), '\n', file);

/**
 * Wires a real VersionActionsService over the provided (real) snapshot. getOne
 * returns the snapshot regardless of the file argument, matching how the service
 * resolves a file's snapshot; applyContent/forceUpdate stay spies so the tests
 * observe the service's side effects without an Obsidian vault.
 */
const makeHarness = (snapshot: FileSnapshot | null): ServiceHarness => {
  const applyContent: Mock = vi.fn(async (): Promise<boolean> => true) as unknown as Mock;
  const forceUpdate: Mock = vi.fn();

  const snapshotsService = {
    getOne: (_file?: TFile | null): unknown => snapshot,
    applyContent,
    forceUpdate,
    reseedOriginIfSlid: vi.fn((): boolean => false),
  };

  const settingsService = {
    value: (path: string): unknown => {
      switch (path) {
        case 'snapshots.enabled':
          return false; // proves the put-label path forces enabled internally
        case 'snapshots.intervalMs':
          return 60000;
        case 'snapshots.editThreshold':
          return 10;
        case 'snapshots.maxVersions':
          return 50;
        case 'snapshots.maxVersionAgeDays':
          return 14;
        default:
          return undefined;
      }
    },
  };

  const plugin = {
    get: (key: unknown): unknown => {
      if (key === TOKENS.snapshots) {
        return snapshotsService;
      }

      if (key === TOKENS.settings) {
        return settingsService;
      }

      throw new Error(`Unknown service: ${String(key)}`);
    },
  } as unknown as ConstructorParameters<typeof VersionActionsService>[0];

  const service = new VersionActionsService(plugin);

  return { service, applyContent, forceUpdate, snapshot };
};

describe('VersionActionsService.restoreSelected', () => {
  it('rewrites the file content to the picked version via SnapshotsService.applyContent', async () => {
    const file = makeFile('a.md');
    const snapshot = makeSnapshot(file, ['current']);
    // Seed one version whose content differs from the current state so the
    // restore is not short-circuited by the no-op guard.
    snapshot.timeline.adopt([new FileVersion(['old', 'lines'])]);
    const versionId: string = snapshot.timeline.getVersions()[0].id;

    const harness = makeHarness(snapshot);

    const result = await harness.service.restoreSelected(file, versionId);

    expect(result.applied).toBe(true);
    expect(harness.applyContent).toHaveBeenCalledTimes(1);
    expect(harness.applyContent).toHaveBeenCalledWith(file, ['old', 'lines'], {
      start: 0,
      removeCount: 1,
      newLines: ['old', 'lines'],
    });
  });

  it('returns applied=false and does not write when the version content equals the current state', async () => {
    const file = makeFile('a.md');
    const snapshot = makeSnapshot(file, ['same']);
    // adopt (not captureVersion) seeds a version equal to the current state:
    // captureVersion would drop it via the no-op dedup, which is exactly the
    // duplicate this case needs the restore to short-circuit on.
    snapshot.timeline.adopt([new FileVersion(['same'])]);
    const versionId: string = snapshot.timeline.getVersions()[0].id;

    const harness = makeHarness(snapshot);

    const result = await harness.service.restoreSelected(file, versionId);

    expect(result.applied).toBe(false);
    expect(harness.applyContent).not.toHaveBeenCalled();
  });

  it('returns applied=false when the snapshot or the version is missing', async () => {
    const noSnapshot = makeHarness(null);
    expect((await noSnapshot.service.restoreSelected(makeFile('a.md'), 'v1')).applied).toBe(false);
    expect(noSnapshot.applyContent).not.toHaveBeenCalled();

    const unknownVersion = makeHarness(makeSnapshot(makeFile('a.md'), ['x']));
    expect((await unknownVersion.service.restoreSelected(makeFile('a.md'), 'missing')).applied).toBe(false);
    expect(unknownVersion.applyContent).not.toHaveBeenCalled();
  });
});

describe('VersionActionsService.removeSelected', () => {
  it('removes the version, calls forceUpdate, and points next at the older neighbour', () => {
    const file = makeFile('a.md');
    // Stored oldest-first, surfaced newest-first by getVersions (so reversed).
    const older = new FileVersion(['o']);
    const middle = new FileVersion(['m']);
    const newer = new FileVersion(['n']);
    const snapshot = makeSnapshot(file, ['x']);
    snapshot.timeline.adopt([older, middle, newer]);

    const harness = makeHarness(snapshot);

    const result = harness.service.removeSelected(file, middle.id);

    expect(result.removed).toBe(true);
    expect(result.nextId).toBe(older.id);
    expect(harness.forceUpdate).toHaveBeenCalledTimes(1);
    // The picked version is gone from the real timeline; its neighbours remain.
    expect(snapshot.timeline.getVersion(middle.id)).toBeNull();
    expect(snapshot.timeline.getVersions().map((v: FileVersion): string => v.id)).toEqual([
      newer.id,
      older.id,
    ]);
  });

  it('falls back to the newer neighbour when removing the oldest entry', () => {
    const file = makeFile('a.md');
    const older = new FileVersion(['o']);
    const newer = new FileVersion(['n']);
    const snapshot = makeSnapshot(file, ['x']);
    snapshot.timeline.adopt([older, newer]);

    const harness = makeHarness(snapshot);

    const result = harness.service.removeSelected(file, older.id);

    expect(result.removed).toBe(true);
    // Newest-first list: [newer, older]; older is the last entry, so the fallback
    // is its newer neighbour (newer), which sits at index - 1.
    expect(result.nextId).toBe(newer.id);
  });

  it('returns nextId=null when the timeline is left empty after the remove', () => {
    const file = makeFile('a.md');
    const only = new FileVersion(['o']);
    const snapshot = makeSnapshot(file, ['x']);
    snapshot.timeline.adopt([only]);

    const harness = makeHarness(snapshot);

    const result = harness.service.removeSelected(file, only.id);

    expect(result.removed).toBe(true);
    expect(result.nextId).toBeNull();
    expect(snapshot.timeline.hasVersions()).toBe(false);
  });

  it('is a no-op when the snapshot is missing or the version id is unknown', () => {
    const noSnapshot = makeHarness(null);
    const empty = noSnapshot.service.removeSelected(makeFile('a.md'), 'v1');
    expect(empty.removed).toBe(false);
    expect(empty.nextId).toBeNull();
    expect(noSnapshot.forceUpdate).not.toHaveBeenCalled();

    const unknown = makeHarness(makeSnapshot(makeFile('a.md'), ['x']));
    const result = unknown.service.removeSelected(makeFile('a.md'), 'missing');
    expect(result.removed).toBe(false);
    expect(unknown.forceUpdate).not.toHaveBeenCalled();
  });
});

describe('VersionActionsService.putLabel', () => {
  it('captures a labeled, forced version of the current state and notifies subscribers', () => {
    const file = makeFile('a.md');
    const snapshot = makeSnapshot(file, ['current']);
    // Spy on the REAL captureVersion so the mode assertions ride the genuine
    // method signature; the spy calls through, so the version still lands.
    const captureSpy = vi.spyOn(snapshot, 'captureVersion');

    const harness = makeHarness(snapshot);

    const captured = harness.service.putLabel(file, ' milestone ');

    expect(captured).not.toBeNull();
    expect(captured?.label).toBe('milestone'); // trimmed
    // Current state frozen, forced (3rd arg), labeled (4th arg), cadence enabled.
    expect(captureSpy).toHaveBeenCalledTimes(1);
    expect(captureSpy).toHaveBeenCalledWith(
      ['current'],
      expect.objectContaining({ enabled: true }),
      true,
      'milestone',
    );
    // The labeled version actually landed on the real timeline.
    expect(snapshot.timeline.getVersions().map((v: FileVersion): string | undefined => v.label)).toEqual([
      'milestone',
    ]);
    expect(harness.forceUpdate).toHaveBeenCalledTimes(1);
  });

  it('forces the cadence-enabled gate so a labeled marker still lands when snapshots are disabled in settings', () => {
    const file = makeFile('a.md');
    const snapshot = makeSnapshot(file, ['x']);
    const captureSpy = vi.spyOn(snapshot, 'captureVersion');

    const harness = makeHarness(snapshot);

    // The settings stub returns enabled=false; captureVersion would return null
    // for a disabled cadence, so a non-null result proves the service flipped
    // the gate on for the intentional marker.
    const captured = harness.service.putLabel(file, 'tag');

    expect(captured).not.toBeNull();
    expect(captured?.label).toBe('tag');
    expect(captureSpy).toHaveBeenCalledWith(
      ['x'],
      expect.objectContaining({ enabled: true }),
      true,
      'tag',
    );
    expect(snapshot.timeline.getVersions()).toHaveLength(1);
  });

  it('is a no-op when the label is empty, whitespace, or no snapshot exists', () => {
    const file = makeFile('a.md');
    const snapshot = makeSnapshot(file, ['x']);
    const captureSpy = vi.spyOn(snapshot, 'captureVersion');

    const harness = makeHarness(snapshot);

    expect(harness.service.putLabel(file, '')).toBeNull();
    expect(harness.service.putLabel(file, '   ')).toBeNull();
    expect(captureSpy).not.toHaveBeenCalled();
    expect(snapshot.timeline.hasVersions()).toBe(false);
    expect(harness.forceUpdate).not.toHaveBeenCalled();

    const noSnapshot = makeHarness(null);
    expect(noSnapshot.service.putLabel(file, 'tag')).toBeNull();
    expect(noSnapshot.forceUpdate).not.toHaveBeenCalled();
  });
});

describe('VersionActionsService.label', () => {
  it('labels the EXISTING picked version in place (not a new capture) and notifies subscribers', () => {
    const file = makeFile('a.md');
    const first = new FileVersion(['one']);
    const second = new FileVersion(['two']);
    const snapshot = makeSnapshot(file, ['current']);
    snapshot.timeline.adopt([first, second]);
    const captureSpy = vi.spyOn(snapshot, 'captureVersion');

    const harness = makeHarness(snapshot);

    const labeled = harness.service.label(file, first.id, '  milestone  ');

    expect(labeled).not.toBeNull();
    expect(labeled?.id).toBe(first.id);
    expect(labeled?.label).toBe('milestone'); // trimmed
    // The label landed on the stored timeline entry, not on a fresh capture.
    expect(snapshot.timeline.getVersion(first.id)?.label).toBe('milestone');
    expect(captureSpy).not.toHaveBeenCalled();
    expect(snapshot.timeline.getVersions()).toHaveLength(2);
    expect(harness.forceUpdate).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when the label is empty/whitespace, the version id is unknown, or no snapshot exists', () => {
    const file = makeFile('a.md');
    const first = new FileVersion(['one']);
    const snapshot = makeSnapshot(file, ['x']);
    snapshot.timeline.adopt([first]);

    const harness = makeHarness(snapshot);

    expect(harness.service.label(file, first.id, '')).toBeNull();
    expect(harness.service.label(file, first.id, '   ')).toBeNull();
    expect(harness.service.label(file, 'missing', 'tag')).toBeNull();
    expect(snapshot.timeline.getVersion(first.id)?.label).toBeUndefined();
    expect(harness.forceUpdate).not.toHaveBeenCalled();

    const noSnapshot = makeHarness(null);
    expect(noSnapshot.service.label(file, 'v1', 'tag')).toBeNull();
    expect(noSnapshot.forceUpdate).not.toHaveBeenCalled();
  });
});
