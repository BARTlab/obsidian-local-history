import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { SnapshotsService } from '@/services/snapshots.service';
import { FileSnapshot } from '@/snapshots/file.snapshot';
import { FileVersion } from '@/snapshots/file.version';
import { TextHelper } from '@/helpers/text.helper';
import type { TFile } from 'obsidian';

import { makeFile } from './helpers/builders';
import { flushMicrotasks } from './helpers/async-utils';

type PluginArg = ConstructorParameters<typeof SnapshotsService>[0];

interface SettingsValues {
  allowedExtensions?: string;
  excludePaths?: string;
  'snapshots.enabled'?: boolean;
  'snapshots.intervalMs'?: number;
  'snapshots.editThreshold'?: number;
  'snapshots.maxVersions'?: number;
  'snapshots.maxVersionAgeDays'?: number;
}

/**
 * Builds a SnapshotsService backed by an in-memory vault map. `read` returns
 * whatever the test seeded for the file path; missing entries throw, matching
 * Obsidian's behaviour for a non-existent file.
 */
const makeService = (
  overrides: SettingsValues = {},
  vaultContent: Record<string, string> = {},
): { service: SnapshotsService; vault: Record<string, string>; settings: SettingsValues } => {
  const settings: SettingsValues = {
    allowedExtensions: 'md',
    excludePaths: '',
    'snapshots.enabled': true,
    'snapshots.intervalMs': 0,
    'snapshots.editThreshold': 0,
    'snapshots.maxVersions': 0,
    'snapshots.maxVersionAgeDays': 0,
    ...overrides,
  };
  const vault: Record<string, string> = { ...vaultContent };
  const settingsService = {
    value: (path: keyof SettingsValues): unknown => settings[path],
  };

  const plugin = {
    getActiveEditorView: (): undefined => undefined,
    getActiveFile: (): null => null,
    getActiveViewOfType: (): null => null,
    t: (key: string): string => key,
    get: (): unknown => settingsService,
    emit: (): void => undefined,
    app: {
      vault: {
        read: async (file: TFile): Promise<string> => {
          if (!(file.path in vault)) {
            throw new Error(`No content for ${file.path}`);
          }

          return vault[file.path];
        },
      },
    },
  } as unknown as PluginArg;

  return { service: new SnapshotsService(plugin), vault, settings };
};

describe('SnapshotsService.captureExternalChange', () => {
  it('is a no-op when the disk hash matches the snapshot state', async () => {
    const { service, vault } = makeService();
    const file = makeFile('notes/a.md', { stat: { mtime: 1, size: 1 } });

    service.add(file, 'one\ntwo\nthree');
    vault[file.path] = 'one\ntwo\nthree';

    const before: FileSnapshot = service.getOne(file) as FileSnapshot;
    const versionsBefore: number = before.versions.length;
    const stateBefore: string[] = before.getLastStateLines();

    await service.captureExternalChange(file);

    const after: FileSnapshot = service.getOne(file) as FileSnapshot;

    expect(after.versions.length).toBe(versionsBefore);
    expect(after.getLastStateLines()).toEqual(stateBefore);
  });

  it('force-captures the new content with external=true on a hash divergence', async () => {
    const { service, vault } = makeService();
    const file = makeFile('notes/a.md', { stat: { mtime: 1, size: 1 } });

    service.add(file, 'one\ntwo\nthree');
    vault[file.path] = 'one\ntwo-external\nthree';

    await service.captureExternalChange(file);

    const after: FileSnapshot = service.getOne(file) as FileSnapshot;

    expect(after.versions.length).toBe(1);
    const captured: FileVersion = after.versions[0];

    expect(captured.isExternal()).toBe(true);
    expect(captured.getLines()).toEqual(['one', 'two-external', 'three']);
    expect(after.getLastStateLines()).toEqual(['one', 'two-external', 'three']);

    // A follow-up call with the same disk content is now a hash-match no-op:
    // updateState rewrote lastHash to the captured content, so the next pass
    // takes the early-return branch instead of duplicating the version.
    await service.captureExternalChange(file);
    expect(after.versions.length).toBe(1);
  });

  it('bypasses the cadence gates so a single external change captures even with zero gates', async () => {
    // Both editThreshold and intervalMs are 0 (disabled) in the defaults, so a
    // non-forced captureVersion would never trigger; this test pins that the
    // external path forces past the gates as D13 requires.
    const { service, vault } = makeService({
      'snapshots.editThreshold': 0,
      'snapshots.intervalMs': 0,
    });
    const file = makeFile('notes/a.md', { stat: { mtime: 1, size: 1 } });

    service.add(file, 'alpha\nbeta');
    vault[file.path] = 'alpha\nbeta-edited';

    await service.captureExternalChange(file);

    const after: FileSnapshot = service.getOne(file) as FileSnapshot;

    expect(after.versions.length).toBe(1);
    expect(after.versions[0].isExternal()).toBe(true);
  });

  it('captures a first-sight file as a new snapshot without an external version', async () => {
    const { service, vault } = makeService();
    const file = makeFile('notes/fresh.md', { stat: { mtime: 1, size: 1 } });

    vault[file.path] = 'fresh content\nline two';

    await service.captureExternalChange(file);

    const snapshot: FileSnapshot | null = service.getOne(file);

    expect(snapshot).not.toBeNull();
    expect(snapshot!.getOriginalStateLines()).toEqual(['fresh content', 'line two']);
    // No external version is recorded on first sight: there is no prior state
    // to diff against, so flagging the very first capture would be wrong.
    expect(snapshot!.versions.length).toBe(0);
  });

  it('is a no-op for a wrong-extension file', async () => {
    const { service, vault } = makeService({ allowedExtensions: 'md' });
    const file = makeFile('notes/binary.bin', { stat: { mtime: 1, size: 1 } });

    vault[file.path] = 'whatever';

    await service.captureExternalChange(file);

    expect(service.getOne(file)).toBeNull();
  });

  it('is a no-op for an excluded path', async () => {
    const { service, vault } = makeService({
      allowedExtensions: 'md',
      excludePaths: '^templates/',
    });
    const file = makeFile('templates/note.md', { stat: { mtime: 1, size: 1 } });

    vault[file.path] = 'banned';

    await service.captureExternalChange(file);

    expect(service.getOne(file)).toBeNull();
  });

  it('is a no-op for a file in the ignore list', async () => {
    const { service, vault } = makeService();
    const file = makeFile('notes/ignored.md', { stat: { mtime: 1, size: 1 } });

    service.add(file, 'one');
    vault[file.path] = 'one-external';
    service.addToIgnoreList(file);

    await service.captureExternalChange(file);

    const snapshot: FileSnapshot = service.getOne(file) as FileSnapshot;

    // State stays at the original capture; ignore-list short-circuits external.
    expect(snapshot.versions.length).toBe(0);
    expect(snapshot.getLastStateLines()).toEqual(['one']);
  });

  it('is a no-op for a tombstone entry', async () => {
    const { service, vault } = makeService();
    const file = makeFile('notes/dead.md', { stat: { mtime: 1, size: 1 } });

    service.add(file, 'still here');
    service.markDeleted(file);
    vault[file.path] = 'resurrected by sync';

    const before: FileSnapshot = service.getOne(file) as FileSnapshot;
    const deletedTimestampBefore: number | undefined = before.deletedTimestamp;
    const versionsBefore: number = before.versions.length;

    await service.captureExternalChange(file);

    const after: FileSnapshot = service.getOne(file) as FileSnapshot;

    expect(after.isTombstone()).toBe(true);
    expect(after.deletedTimestamp).toBe(deletedTimestampBefore);
    expect(after.versions.length).toBe(versionsBefore);
  });

  it('keeps an external version evictable under the count cap', async () => {
    // maxVersions = 1 with a labeled cadence-pinned existing version means a
    // freshly captured external version should be evictable while the labeled
    // entry survives. Mirrors D13: external versions are NOT pinned.
    const { service, vault } = makeService({
      'snapshots.maxVersions': 1,
    });
    const file = makeFile('notes/a.md', { stat: { mtime: 1, size: 1 } });

    service.add(file, 'initial');
    const seeded: FileSnapshot = service.getOne(file) as FileSnapshot;

    // Pin a labeled version manually so the eviction count compares only
    // unlabeled (external) entries against maxVersions.
    seeded.versions.push(new FileVersion(['initial'], Date.now() - 1000, 'pin'));

    vault[file.path] = 'changed-externally';
    await service.captureExternalChange(file);

    const after: FileSnapshot = service.getOne(file) as FileSnapshot;
    const externalCount: number = after.versions.filter((v: FileVersion): boolean => v.isExternal()).length;
    const labeledCount: number = after.versions.filter((v: FileVersion): boolean => v.isLabeled()).length;

    // The labeled marker is pinned; the external sits under the unlabeled cap
    // of 1 and is NOT exempt from eviction. With one labeled + one external,
    // the count cap is satisfied (only unlabeled count, so external stays).
    expect(labeledCount).toBe(1);
    expect(externalCount).toBe(1);

    // Add a second external state; eviction should drop the older external
    // because external entries are evictable like cadence versions. Bump the
    // stat so the ADR-08-E mtime/size pre-check does not short-circuit the
    // genuine content change.
    vault[file.path] = 'changed-again';
    const bumped: TFile = makeFile(file.path, { stat: { mtime: 2, size: 2 } });

    await service.captureExternalChange(bumped);

    const final: FileSnapshot = service.getOne(bumped) as FileSnapshot;
    const finalUnlabeled: FileVersion[] = final.versions.filter(
      (v: FileVersion): boolean => !v.isLabeled(),
    );

    expect(finalUnlabeled.length).toBe(1);
    // The newer external survived; an external version is NOT pinned.
    expect(finalUnlabeled[0].getLines()).toEqual(['changed-again']);
    expect(finalUnlabeled[0].isExternal()).toBe(true);
  });

  it('does nothing when there is no file', async () => {
    const { service } = makeService();

    await expect(service.captureExternalChange(null)).resolves.toBeUndefined();
    await expect(service.captureExternalChange(undefined)).resolves.toBeUndefined();
  });

  it('skips the disk read when mtime and size match the last-seen values', async () => {
    const { service, vault } = makeService();
    let reads: number = 0;
    const originalRead = (service as unknown as {
      plugin: { app: { vault: { read: (file: TFile) => Promise<string> } } };
    }).plugin.app.vault.read;

    (service as unknown as {
      plugin: { app: { vault: { read: (file: TFile) => Promise<string> } } };
    }).plugin.app.vault.read = async (file: TFile): Promise<string> => {
      reads += 1;

      return originalRead(file);
    };

    const file: TFile = makeFile('notes/a.md', { stat: { mtime: 10, size: 3 } });

    service.add(file, 'one\ntwo');
    vault[file.path] = 'one\ntwo';

    // First pass: stat is unseen, disk read runs and seeds last-seen.
    await service.captureExternalChange(file);
    expect(reads).toBe(1);

    // Second pass with identical stat: short-circuits before the read.
    await service.captureExternalChange(file);
    expect(reads).toBe(1);

    // Stat changed (mtime bumped): the pre-check no longer matches, disk
    // read runs again even though the content turns out to be identical.
    const bumped: TFile = makeFile('notes/a.md', { stat: { mtime: 20, size: 3 } });

    vault[bumped.path] = 'one\ntwo';
    await service.captureExternalChange(bumped);
    expect(reads).toBe(2);
  });

  it('still captures an external rewrite of a stat-changed file', async () => {
    // Pins ADR-5: the modify path must not gate on "is the active file"; a
    // genuine external rewrite (different stat, different content) is
    // captured even if the user happens to be viewing the file.
    const { service, vault } = makeService();
    const before: TFile = makeFile('notes/open.md', { stat: { mtime: 5, size: 7 } });

    service.add(before, 'alpha\nbeta');
    vault[before.path] = 'alpha\nbeta';
    await service.captureExternalChange(before);

    const after: TFile = makeFile('notes/open.md', { stat: { mtime: 6, size: 15 } });

    vault[after.path] = 'alpha-external\nbeta';
    await service.captureExternalChange(after);

    const snapshot: FileSnapshot = service.getOne(after) as FileSnapshot;

    expect(snapshot.versions.length).toBe(1);
    expect(snapshot.versions[0].isExternal()).toBe(true);
    expect(snapshot.getLastStateLines()).toEqual(['alpha-external', 'beta']);
  });

  it('falls through when the file has no usable stat block', async () => {
    // Older Obsidian builds and test stubs may not surface stat at all.
    // The pre-check must treat a missing stat as "unknown" (not "matches")
    // so we never wrongly short-circuit and miss an actual disk change.
    const { service, vault } = makeService();
    const file: TFile = { path: 'notes/no-stat.md', name: 'no-stat.md', extension: 'md' } as unknown as TFile;

    service.add(file, 'one');
    vault[file.path] = 'one-external';

    await service.captureExternalChange(file);

    const snapshot: FileSnapshot = service.getOne(file) as FileSnapshot;

    expect(snapshot.versions.length).toBe(1);
    expect(snapshot.versions[0].isExternal()).toBe(true);
  });

  it('captures a hash-collision rewrite where the 32-bit hash matches but the content differs', async (): Promise<void> => {
    // ADR-08-D regression: a genuine external change must never be dropped
    // because its weak 32-bit hash collides with the known state. We force a
    // collision by overwriting the snapshot's `lastHash` with the hash of the
    // new disk content while leaving `state` at the original lines, so the
    // pre-filter says "match" and the content compare must catch the diff.
    const { service, vault } = makeService();
    const file: TFile = makeFile('notes/collision.md', { stat: { mtime: 1, size: 5 } });

    service.add(file, 'one\ntwo');
    const snapshot: FileSnapshot = service.getOne(file) as FileSnapshot;
    const colliding: string = 'three\nfour';

    // Use the production hash so the pre-filter genuinely matches: this
    // simulates the collision deterministically without depending on a known
    // 32-bit input pair.
    snapshot.lastHash = TextHelper.hash(colliding);
    vault[file.path] = colliding;

    await service.captureExternalChange(file);

    const after: FileSnapshot = service.getOne(file) as FileSnapshot;

    expect(after.versions.length).toBe(1);
    expect(after.versions[0].isExternal()).toBe(true);
    expect(after.versions[0].getLines()).toEqual(['three', 'four']);
    expect(after.getLastStateLines()).toEqual(['three', 'four']);
  });

  it('stays a no-op when the hash matches AND the content actually matches', async () => {
    // The content-equality fallback must not regress the common-case no-op:
    // when both the hash and the line array match, we still skip the capture.
    const { service, vault } = makeService();
    const file: TFile = makeFile('notes/same.md', { stat: { mtime: 1, size: 7 } });

    service.add(file, 'one\ntwo\nthree');
    vault[file.path] = 'one\ntwo\nthree';

    const snapshot: FileSnapshot = service.getOne(file) as FileSnapshot;
    const versionsBefore: number = snapshot.versions.length;

    await service.captureExternalChange(file);

    const after: FileSnapshot = service.getOne(file) as FileSnapshot;

    expect(after.versions.length).toBe(versionsBefore);
    expect(after.getLastStateLines()).toEqual(['one', 'two', 'three']);
  });
});

describe('SnapshotsService.scheduleExternalCapture', () => {
  beforeEach((): void => {
    jest.useFakeTimers();
  });

  afterEach((): void => {
    jest.useRealTimers();
  });

  it('coalesces a burst of modify events into a single disk read + capture', async () => {
    const { service, vault } = makeService();
    let reads: number = 0;
    const originalRead = (service as unknown as {
      plugin: { app: { vault: { read: (file: TFile) => Promise<string> } } };
    }).plugin.app.vault.read;

    (service as unknown as {
      plugin: { app: { vault: { read: (file: TFile) => Promise<string> } } };
    }).plugin.app.vault.read = async (file: TFile): Promise<string> => {
      reads += 1;

      return originalRead(file);
    };

    const file: TFile = makeFile('notes/burst.md', { stat: { mtime: 1, size: 3 } });

    service.add(file, 'one\ntwo');
    vault[file.path] = 'one\ntwo-external';

    // Fire ten modify events back-to-back inside the debounce window. Only
    // the trailing call should result in a disk read + capture.
    for (let i: number = 0; i < 10; i += 1) {
      service.scheduleExternalCapture(file);
    }

    expect(reads).toBe(0);

    await jest.runAllTimersAsync();
    await flushMicrotasks();

    const snapshot: FileSnapshot = service.getOne(file) as FileSnapshot;

    expect(reads).toBe(1);
    expect(snapshot.versions.length).toBe(1);
    expect(snapshot.versions[0].isExternal()).toBe(true);
  });

  it('runs independent files concurrently without cross-debounce', async () => {
    const { service, vault } = makeService();
    const fileA: TFile = makeFile('notes/a.md', { stat: { mtime: 1, size: 3 } });
    const fileB: TFile = makeFile('notes/b.md', { stat: { mtime: 1, size: 5 } });

    service.add(fileA, 'a-one');
    service.add(fileB, 'b-one');
    vault[fileA.path] = 'a-external';
    vault[fileB.path] = 'b-external';

    service.scheduleExternalCapture(fileA);
    service.scheduleExternalCapture(fileB);

    await jest.runAllTimersAsync();
    await flushMicrotasks();

    expect((service.getOne(fileA) as FileSnapshot).versions.length).toBe(1);
    expect((service.getOne(fileB) as FileSnapshot).versions.length).toBe(1);
  });
});
