import 'reflect-metadata';
import { describe, expect, it } from '@jest/globals';
import { VERSION_KEYFRAME_INTERVAL } from '@/consts';
import { SnapshotsService } from '@/services/snapshots.service';
import { FileSnapshot } from '@/snapshots/file.snapshot';
import { FileVersion } from '@/snapshots/file.version';
import type { SerializedFileSnapshot } from '@/types';
import type { TFile } from 'obsidian';

/**
 * Tests for SnapshotsService serialize/restore (T5.1). They use the real
 * FileSnapshot so the serialize -> restore path is exercised end to end,
 * including the pristine-overwrite rule and skipping files that no longer exist.
 */

type PluginArg = ConstructorParameters<typeof SnapshotsService>[0];

const makeFile = (path: string): TFile =>
  ({ path, name: path.split('/').pop() ?? path } as unknown as TFile);

/**
 * Builds a service whose host plugin resolves only the given set of paths to
 * live files (mimicking the vault index after some files were deleted offline).
 */
const makeService = (existingPaths: string[] = []): SnapshotsService => {
  const present: Set<string> = new Set(existingPaths);

  const plugin = {
    getActiveEditorView: (): undefined => undefined,
    getFileByPath: (path: string): TFile | null => (present.has(path) ? makeFile(path) : null),
  } as unknown as PluginArg;

  return new SnapshotsService(plugin);
};

describe('SnapshotsService.serialize', () => {
  it('includes only snapshots that have tracked changes', () => {
    const service = makeService();
    const clean = makeFile('clean.md');
    const dirty = makeFile('dirty.md');

    service.add(clean, 'a\nb');
    service.add(dirty, 'a\nb');

    const dirtySnapshot: FileSnapshot = service.getOne(dirty);
    dirtySnapshot.findCurrentLine(1)?.change('B');
    dirtySnapshot.updateState(['a', 'B']);
    dirtySnapshot.updateChanges();

    const payload = service.serialize();

    expect(payload.version).toBe(2);
    expect(payload.snapshots).toHaveLength(1);
    expect(payload.snapshots[0].path).toBe('dirty.md');
  });

  it('serializes a snapshot that has versions even with no current changes', () => {
    const service = makeService(['timeline.md']);
    const file = makeFile('timeline.md');

    service.add(file, 'a\nb');
    const snapshot: FileSnapshot = service.getOne(file);

    // Capture an intermediate version, then return the state to the original so
    // there are no tracked changes but the timeline still holds history.
    snapshot.captureVersion(['a', 'edited'], {
      enabled: true,
      intervalMs: 0,
      editThreshold: 1,
      maxVersions: 0,
      maxVersionAgeDays: 0,
    });
    expect(snapshot.getChangesLinesCount()).toBe(0);
    expect(snapshot.hasVersions()).toBe(true);

    const payload = service.serialize();
    expect(payload.snapshots).toHaveLength(1);
    expect(payload.snapshots[0].versions).toHaveLength(1);

    // Round-trips back through restore with the timeline intact.
    const fresh = makeService(['timeline.md']);
    fresh.restore(payload.snapshots);
    expect(fresh.getOne(file)?.getVersions()).toHaveLength(1);
  });
});

describe('SnapshotsService.restore', () => {
  const dirtySerialized = (path: string): SerializedFileSnapshot => {
    const snapshot = new FileSnapshot('a\nb\nc', '\n', makeFile(path));
    snapshot.findCurrentLine(1)?.change('B');
    snapshot.updateState(['a', 'B', 'c']);
    snapshot.updateChanges();

    return snapshot.toJSON();
  };

  it('rebuilds a not-yet-captured file session-clean while keeping its history', () => {
    const service = makeService(['a.md']);

    service.restore([dirtySerialized('a.md')]);

    const restored: FileSnapshot | null = service.getOne(makeFile('a.md'));
    expect(restored).not.toBeNull();
    expect(restored?.file?.path).toBe('a.md');

    // The session marker baseline is re-established on the current state at
    // restore, so a fresh launch starts session-clean and the tree/tab decorator
    // paints nothing until the file is edited this session.
    expect(restored?.getChangesLinesCount()).toBe(0);
    expect(restored?.getOriginalStateLines()).toEqual(['a', 'B', 'c']);

    // No data is lost: the current state and the persisted history baseline are
    // preserved, so the history modal still diffs against the original.
    expect(restored?.getLastStateLines()).toEqual(['a', 'B', 'c']);
    expect(restored?.getHistoryOriginalStateLines()).toEqual(['a', 'b', 'c']);
  });

  it('auto-tombstones entries whose live file no longer exists (T05 AC4)', () => {
    // Pre-T05 the entry would have been silently dropped. T05 changes this:
    // a serialized live snapshot whose file is gone on restore is rebuilt as
    // a tombstone (deletedTimestamp = data.timestamp), so the deleted-file
    // history survives a plugin-off deletion. The dedicated tombstone tests
    // live in tests/persistence.service.tombstone.test.ts; this case stays
    // here to pin the older contract's update.
    const service = makeService([]); // nothing resolves

    service.restore([dirtySerialized('gone.md')]);

    const orphan: FileSnapshot | null = service.getOne(makeFile('gone.md'));

    expect(orphan).not.toBeNull();
    expect(orphan!.isTombstone()).toBe(true);
  });

  it('keeps a pristine session marker baseline and adopts only the history baseline (D2)', () => {
    const service = makeService(['a.md']);

    // Pristine session capture: the marker baseline is this open's content.
    service.add(makeFile('a.md'), 'x\ny\nz');
    const live: FileSnapshot = service.getOne(makeFile('a.md'));
    expect(live.getChangesLinesCount()).toBe(0);

    // The persisted history carries a different original ("a\nb\nc") and an edit.
    service.restore([dirtySerialized('a.md')]);

    const restored: FileSnapshot | null = service.getOne(makeFile('a.md'));

    // Markers stay session-scoped: the marker baseline and tracker are untouched,
    // so the gutter shows no change against this open's content.
    expect(restored?.getChangesLinesCount()).toBe(0);
    expect(restored?.getOriginalStateLines()).toEqual(['x', 'y', 'z']);
    expect(restored?.getLastStateLines()).toEqual(['x', 'y', 'z']);

    // The modal regains the persisted history baseline (the original birth state).
    expect(restored?.getHistoryOriginalStateLines()).toEqual(['a', 'b', 'c']);
  });

  it('does not clobber an in-memory snapshot that already has changes', () => {
    const service = makeService(['a.md']);

    service.add(makeFile('a.md'), 'a\nb\nc');
    const live: FileSnapshot = service.getOne(makeFile('a.md'));
    live.findCurrentLine(0)?.change('Z');
    live.updateState(['Z', 'b', 'c']);
    live.updateChanges();

    service.restore([dirtySerialized('a.md')]);

    // The session state and marker baseline win; only history is adopted.
    expect(service.getOne(makeFile('a.md'))?.getLastStateLines()).toEqual(['Z', 'b', 'c']);
    expect(service.getOne(makeFile('a.md'))?.getOriginalStateLines()).toEqual(['a', 'b', 'c']);
  });

  it('ignores malformed input', () => {
    const service = makeService(['a.md']);

    service.restore(null as unknown as SerializedFileSnapshot[]);
    service.restore([null as unknown as SerializedFileSnapshot]);
    service.restore([{ path: '' } as SerializedFileSnapshot]);

    expect(service.getList()).toHaveLength(0);
  });
});

describe('SnapshotsService delta-encoded version round-trip (T07)', () => {
  const PATH = 'timeline.md';
  const TOTAL: number = VERSION_KEYFRAME_INTERVAL + 5; // > one keyframe interval

  // Indices (oldest-first) that carry flags, both inside the delta region so
  // flag survival is asserted on delta entries, not only on keyframes.
  const LABELED_INDEX = 3;
  const EXTERNAL_INDEX = 7;

  /**
   * Builds a live snapshot inside a service whose timeline holds TOTAL versions,
   * oldest-first, with realistically sized line content so consecutive versions
   * diff into compact deltas. One version is labeled and one is external, both
   * placed in the delta region (not on a keyframe boundary).
   *
   * @return {{ service: SnapshotsService; file: TFile; versions: FileVersion[] }}
   *   The seeded service, its live file, and the original timeline (oldest-first).
   */
  const seed = (): { service: SnapshotsService; file: TFile; versions: FileVersion[] } => {
    const service = makeService([PATH]);
    const file = makeFile(PATH);

    service.add(file, 'line-0\nline-1\nline-2');
    const snapshot: FileSnapshot = service.getOne(file);

    const versions: FileVersion[] = [];

    for (let i = 0; i < TOTAL; i += 1) {
      // Each version differs from its predecessor by one line plus a stable body,
      // so a unified-diff delta against i-1 stays small while still non-empty.
      const lines: string[] = [
        'header',
        `edit number ${i}`,
        'shared body line a',
        'shared body line b',
        `tail ${i}`,
      ];

      const label: string | undefined = i === LABELED_INDEX ? `pinned ${i}` : undefined;
      const external: boolean = i === EXTERNAL_INDEX;

      versions.push(new FileVersion(lines, 1_700_000_000_000 + i * 1_000, label, external));
    }

    // The façade owns the versions array; assign the materialized timeline
    // directly (oldest-first) the way the timeline operators do internally.
    snapshot.versions = versions;

    return { service, file, versions };
  };

  it('emits at least one delta entry once the timeline exceeds the keyframe interval', () => {
    const { service } = seed();

    const payload = service.serialize();

    expect(payload.version).toBe(2);
    expect(payload.snapshots).toHaveLength(1);

    const serializedVersions = payload.snapshots[0].versions;
    expect(serializedVersions).toHaveLength(TOTAL);

    const deltaCount: number = serializedVersions.filter(
      (entry): boolean => typeof entry.delta === 'string',
    ).length;
    const keyframeCount: number = serializedVersions.filter(
      (entry): boolean => Array.isArray(entry.lines),
    ).length;

    expect(deltaCount).toBeGreaterThan(0);
    // Keyframes land at i % interval === 0: index 0 and index 25 for TOTAL = 30.
    expect(keyframeCount).toBe(2);
    expect(deltaCount).toBe(TOTAL - keyframeCount);
  });

  it('reconstructs every version byte-identically across the JSON disk transport', () => {
    const { service, file, versions } = seed();

    // Exercise the real disk boundary: serialize -> JSON string -> parse.
    const onDisk: string = JSON.stringify(service.serialize());
    const parsed = JSON.parse(onDisk) as ReturnType<SnapshotsService['serialize']>;

    const fresh = makeService([PATH]);
    fresh.restore(parsed.snapshots);

    // getVersions() returns newest-first; reverse back to the oldest-first order
    // the originals were authored in for a positional comparison.
    const restored: FileVersion[] = [...(fresh.getOne(file)?.getVersions() ?? [])].reverse();

    expect(restored).toHaveLength(versions.length);

    for (let i = 0; i < versions.length; i += 1) {
      expect(restored[i].lines).toEqual(versions[i].lines);
      expect(restored[i].timestamp).toBe(versions[i].timestamp);
    }
  });

  it('preserves label and external flags end-to-end through the service', () => {
    const { service, file, versions } = seed();

    const parsed = JSON.parse(JSON.stringify(service.serialize())) as ReturnType<
      SnapshotsService['serialize']
    >;

    const fresh = makeService([PATH]);
    fresh.restore(parsed.snapshots);

    const restored: FileVersion[] = [...(fresh.getOne(file)?.getVersions() ?? [])].reverse();

    expect(restored[LABELED_INDEX].label).toBe(versions[LABELED_INDEX].label);
    expect(restored[LABELED_INDEX].label).toBe(`pinned ${LABELED_INDEX}`);
    expect(restored[EXTERNAL_INDEX].external).toBe(true);

    // Flags do not bleed onto neighbouring versions.
    expect(restored[LABELED_INDEX + 1].label).toBeUndefined();
    expect(restored[EXTERNAL_INDEX + 1].external).toBeUndefined();
  });
});
