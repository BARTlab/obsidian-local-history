import 'reflect-metadata';
import { describe, expect, it } from '@jest/globals';

import { SnapshotsService } from '@/services/snapshots.service';
import { FileSnapshot } from '@/snapshots/file.snapshot';
import { FileVersion } from '@/snapshots/file.version';
import type { TFile } from 'obsidian';

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

const makeFile = (path: string): TFile => {
  const name: string = path.split('/').pop() ?? path;
  const extension: string = name.includes('.') ? name.split('.').pop() ?? '' : '';

  return { path, name, extension } as unknown as TFile;
};

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
    const file = makeFile('notes/a.md');

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
    const file = makeFile('notes/a.md');

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
    const file = makeFile('notes/a.md');

    service.add(file, 'alpha\nbeta');
    vault[file.path] = 'alpha\nbeta-edited';

    await service.captureExternalChange(file);

    const after: FileSnapshot = service.getOne(file) as FileSnapshot;

    expect(after.versions.length).toBe(1);
    expect(after.versions[0].isExternal()).toBe(true);
  });

  it('captures a first-sight file as a new snapshot without an external version', async () => {
    const { service, vault } = makeService();
    const file = makeFile('notes/fresh.md');

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
    const file = makeFile('notes/binary.bin');

    vault[file.path] = 'whatever';

    await service.captureExternalChange(file);

    expect(service.getOne(file)).toBeNull();
  });

  it('is a no-op for an excluded path', async () => {
    const { service, vault } = makeService({
      allowedExtensions: 'md',
      excludePaths: '^templates/',
    });
    const file = makeFile('templates/note.md');

    vault[file.path] = 'banned';

    await service.captureExternalChange(file);

    expect(service.getOne(file)).toBeNull();
  });

  it('is a no-op for a file in the ignore list', async () => {
    const { service, vault } = makeService();
    const file = makeFile('notes/ignored.md');

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
    const file = makeFile('notes/dead.md');

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
    const file = makeFile('notes/a.md');

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
    // because external entries are evictable like cadence versions.
    vault[file.path] = 'changed-again';
    await service.captureExternalChange(file);

    const final: FileSnapshot = service.getOne(file) as FileSnapshot;
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
});
