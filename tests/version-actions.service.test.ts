import 'reflect-metadata';
import { describe, expect, it, jest } from '@jest/globals';

// Replace the FileSnapshot with a thin in-memory double. The service only needs
// getOne -> snapshot.file, getLastStateLines, lineBreak, captureVersion, and the
// timeline sub-object (getVersion, getVersions, removeVersion), and we want to
// assert the modes (force/labeled) the put-label path uses without pulling
// lodash-es ESM into the CommonJS Jest runtime.
type VersionEntry = { id: string; lines: string[]; label?: string };

jest.mock('@/snapshots/file.snapshot', () => ({
  FileSnapshot: class {
    public file: unknown;
    public captured: { lines: string[]; force: boolean; label?: string }[] = [];
    public removed: string[] = [];
    public versionsList: VersionEntry[] = [];

    // The state/baseline surface lives on the content sub-object, mirroring the
    // real FileSnapshot; captureVersion stays a facade method (below).
    public content: {
      lineBreak: string;
      state: string[];
      getLastStateLines: () => string[];
    };

    // The version-query surface lives on the timeline sub-object, mirroring the
    // real FileSnapshot; captureVersion stays a facade method (below).
    public timeline: {
      getVersion: (id: string) => (VersionEntry & { getLines: () => string[] }) | null;
      getVersions: () => VersionEntry[];
      removeVersion: (id: string) => boolean;
    };

    public constructor(file: unknown, state: string[], versions: VersionEntry[] = []) {
      this.file = file;
      this.versionsList = versions;

      this.content = {
        lineBreak: '\n',
        state,
        getLastStateLines: (): string[] => [...this.content.state],
      };

      this.timeline = {
        getVersion: (id: string): (VersionEntry & { getLines: () => string[] }) | null => {
          const entry = this.versionsList.find((v) => v.id === id);

          if (!entry) {
            return null;
          }

          // Return the STORED reference (augmented with getLines), mirroring the
          // real timeline.getVersion: a caller that sets .label must persist it
          // onto the timeline entry, which labelVersion relies on.
          return Object.assign(entry, { getLines: (): string[] => [...entry.lines] });
        },
        // Mirror the real timeline: newest first.
        getVersions: (): VersionEntry[] => [...this.versionsList].reverse(),
        removeVersion: (id: string): boolean => {
          const index: number = this.versionsList.findIndex((v) => v.id === id);

          if (index === -1) {
            return false;
          }

          this.versionsList.splice(index, 1);
          this.removed.push(id);

          return true;
        },
      };
    }

    public captureVersion(
      lines: string[],
      _options: unknown,
      force: boolean = false,
      label?: string,
    ): { id: string; lines: string[]; label?: string } | null {
      const entry = { id: `v-${this.captured.length + 1}`, lines: [...lines], label };
      this.captured.push({ lines: [...lines], force, label });

      if (label) {
        this.versionsList.push(entry);
      }

      return entry;
    }
  },
}));

import { FileSnapshot } from '@/snapshots/file.snapshot';
import { VersionActionsService } from '@/services/version-actions.service';
import { TOKENS } from '@/services/tokens';
import type { TFile } from 'obsidian';

import { makeFile } from './helpers/builders';

interface ServiceHarness {
  service: VersionActionsService;
  applyContent: jest.Mock;
  forceUpdate: jest.Mock;
  snapshot: {
    file: TFile;
    captured: { lines: string[]; force: boolean; label?: string }[];
    removed: string[];
    versionsList: { id: string; lines: string[]; label?: string }[];
    content: { getLastStateLines: () => string[] };
  } | null;
}

const makeHarness = (snapshotInit?: {
  file: TFile;
  state: string[];
  versions?: { id: string; lines: string[]; label?: string }[];
} | null): ServiceHarness => {
  const applyContent: jest.Mock = jest.fn(async (): Promise<boolean> => true) as unknown as jest.Mock;
  const forceUpdate: jest.Mock = jest.fn();

  // FileSnapshot is mocked above to a thin double; the constructor signature
  // matches the mock, not the real class.
  const SnapshotCtor = FileSnapshot as unknown as new (
    file: TFile,
    state: string[],
    versions?: { id: string; lines: string[]; label?: string }[],
  ) => ServiceHarness['snapshot'];

  const snapshot = snapshotInit
    ? new SnapshotCtor(snapshotInit.file, snapshotInit.state, snapshotInit.versions ?? [])
    : null;

  const snapshotsService = {
    getOne: (_file?: TFile | null): unknown => snapshot,
    applyContent,
    forceUpdate,
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
    const harness = makeHarness({
      file,
      state: ['current'],
      versions: [{ id: 'v1', lines: ['old', 'lines'] }],
    });

    const result = await harness.service.restoreSelected(file, 'v1');

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
    const harness = makeHarness({
      file,
      state: ['same'],
      versions: [{ id: 'v1', lines: ['same'] }],
    });

    const result = await harness.service.restoreSelected(file, 'v1');

    expect(result.applied).toBe(false);
    expect(harness.applyContent).not.toHaveBeenCalled();
  });

  it('returns applied=false when the snapshot or the version is missing', async () => {
    const noSnapshot = makeHarness(null);
    expect((await noSnapshot.service.restoreSelected(makeFile('a.md'), 'v1')).applied).toBe(false);
    expect(noSnapshot.applyContent).not.toHaveBeenCalled();

    const unknownVersion = makeHarness({ file: makeFile('a.md'), state: ['x'], versions: [] });
    expect((await unknownVersion.service.restoreSelected(makeFile('a.md'), 'missing')).applied).toBe(false);
    expect(unknownVersion.applyContent).not.toHaveBeenCalled();
  });
});

describe('VersionActionsService.removeSelected', () => {
  it('removes the version, calls forceUpdate, and points next at the older neighbour', () => {
    const file = makeFile('a.md');
    // Stored oldest-first, surfaced newest-first by getVersions (so reversed).
    const harness = makeHarness({
      file,
      state: ['x'],
      versions: [
        { id: 'old', lines: ['o'] },
        { id: 'mid', lines: ['m'] },
        { id: 'new', lines: ['n'] },
      ],
    });

    const result = harness.service.removeSelected(file, 'mid');

    expect(result.removed).toBe(true);
    expect(result.nextId).toBe('old');
    expect(harness.forceUpdate).toHaveBeenCalledTimes(1);
    expect(harness.snapshot?.removed).toEqual(['mid']);
  });

  it('falls back to the newer neighbour when removing the oldest entry', () => {
    const file = makeFile('a.md');
    const harness = makeHarness({
      file,
      state: ['x'],
      versions: [
        { id: 'old', lines: ['o'] },
        { id: 'new', lines: ['n'] },
      ],
    });

    const result = harness.service.removeSelected(file, 'old');

    expect(result.removed).toBe(true);
    // Newest-first list: [new, old]; old is the last entry, so the fallback is
    // its newer neighbour (new), which sits at index - 1.
    expect(result.nextId).toBe('new');
  });

  it('returns nextId=null when the timeline is left empty after the remove', () => {
    const file = makeFile('a.md');
    const harness = makeHarness({
      file,
      state: ['x'],
      versions: [{ id: 'only', lines: ['o'] }],
    });

    const result = harness.service.removeSelected(file, 'only');

    expect(result.removed).toBe(true);
    expect(result.nextId).toBeNull();
  });

  it('is a no-op when the snapshot is missing or the version id is unknown', () => {
    const noSnapshot = makeHarness(null);
    const empty = noSnapshot.service.removeSelected(makeFile('a.md'), 'v1');
    expect(empty.removed).toBe(false);
    expect(empty.nextId).toBeNull();
    expect(noSnapshot.forceUpdate).not.toHaveBeenCalled();

    const unknown = makeHarness({ file: makeFile('a.md'), state: ['x'], versions: [] });
    const result = unknown.service.removeSelected(makeFile('a.md'), 'missing');
    expect(result.removed).toBe(false);
    expect(unknown.forceUpdate).not.toHaveBeenCalled();
  });
});

describe('VersionActionsService.putLabel', () => {
  it('captures a labeled, forced version of the current state and notifies subscribers', () => {
    const file = makeFile('a.md');
    const harness = makeHarness({ file, state: ['current'] });

    const captured = harness.service.putLabel(file, ' milestone ');

    expect(captured).not.toBeNull();
    expect(captured?.label).toBe('milestone'); // trimmed
    expect(harness.snapshot?.captured).toEqual([
      { lines: ['current'], force: true, label: 'milestone' },
    ]);
    expect(harness.forceUpdate).toHaveBeenCalledTimes(1);
  });

  it('forces the cadence-enabled gate so a labeled marker still lands when snapshots are disabled in settings', () => {
    const file = makeFile('a.md');
    const harness = makeHarness({ file, state: ['x'] });

    // The settings stub returns enabled=false, but the service flips it on for
    // the labeled capture so the intentional marker is not silently dropped.
    const captured = harness.service.putLabel(file, 'tag');

    expect(captured).not.toBeNull();
    expect(harness.snapshot?.captured[0].label).toBe('tag');
    expect(harness.snapshot?.captured[0].force).toBe(true);
  });

  it('is a no-op when the label is empty, whitespace, or no snapshot exists', () => {
    const file = makeFile('a.md');
    const harness = makeHarness({ file, state: ['x'] });

    expect(harness.service.putLabel(file, '')).toBeNull();
    expect(harness.service.putLabel(file, '   ')).toBeNull();
    expect(harness.snapshot?.captured).toEqual([]);
    expect(harness.forceUpdate).not.toHaveBeenCalled();

    const noSnapshot = makeHarness(null);
    expect(noSnapshot.service.putLabel(file, 'tag')).toBeNull();
    expect(noSnapshot.forceUpdate).not.toHaveBeenCalled();
  });
});

describe('VersionActionsService.label', () => {
  it('labels the EXISTING picked version in place (not a new capture) and notifies subscribers', () => {
    const file = makeFile('a.md');
    const harness = makeHarness({
      file,
      state: ['current'],
      versions: [
        { id: 'v1', lines: ['one'] },
        { id: 'v2', lines: ['two'] },
      ],
    });

    const labeled = harness.service.label(file, 'v1', '  milestone  ');

    expect(labeled).not.toBeNull();
    expect(labeled?.id).toBe('v1');
    expect(labeled?.label).toBe('milestone'); // trimmed
    // The label landed on the stored timeline entry, not on a fresh capture.
    expect(harness.snapshot?.versionsList.find((v) => v.id === 'v1')?.label).toBe('milestone');
    expect(harness.snapshot?.captured).toEqual([]);
    expect(harness.forceUpdate).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when the label is empty/whitespace, the version id is unknown, or no snapshot exists', () => {
    const file = makeFile('a.md');
    const harness = makeHarness({
      file,
      state: ['x'],
      versions: [{ id: 'v1', lines: ['one'] }],
    });

    expect(harness.service.label(file, 'v1', '')).toBeNull();
    expect(harness.service.label(file, 'v1', '   ')).toBeNull();
    expect(harness.service.label(file, 'missing', 'tag')).toBeNull();
    expect(harness.snapshot?.versionsList.find((v) => v.id === 'v1')?.label).toBeUndefined();
    expect(harness.forceUpdate).not.toHaveBeenCalled();

    const noSnapshot = makeHarness(null);
    expect(noSnapshot.service.label(file, 'v1', 'tag')).toBeNull();
    expect(noSnapshot.forceUpdate).not.toHaveBeenCalled();
  });
});
