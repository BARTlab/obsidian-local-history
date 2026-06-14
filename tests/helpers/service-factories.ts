import { SnapshotsService } from '@/services/snapshots.service';

import { makeFile } from './builders';

import type { TFile } from 'obsidian';

/**
 * Shared service factories for the test suite. These replace the per-file copies
 * that re-declared the same `SnapshotsService` construction across suites. The
 * intent is setup-only: nothing here changes what a test asserts, it only
 * removes the duplicated construction.
 *
 * Only genuinely identical factories live here. File-specific service factories
 * (i18n, settings, resilience, the settings-aware variant) stay local because
 * they construct different service classes or have file-specific plugin wiring
 * and are not duplication.
 */

type PluginArg = ConstructorParameters<typeof SnapshotsService>[0];

/**
 * Builds a bare {@link SnapshotsService} over a minimal host plugin that has no
 * active editor view and echoes translation keys. This is the identical factory
 * the snapshots.service, snapshots.service.move, and snapshots.service.tombstone
 * suites each re-declared.
 */
export const makeSnapshotsService = (): SnapshotsService => {
  const plugin = {
    getActiveEditorView: (): undefined => undefined,
    t: (key: string): string => key,
  } as unknown as PluginArg;

  return new SnapshotsService(plugin);
};

/**
 * Builds a {@link SnapshotsService} whose host plugin resolves only the given
 * set of paths to live files, mimicking the vault index at the moment restore
 * runs: paths absent from the set return null from `getFileByPath`, which is
 * what `restoreFromDisk` consults to detect deleted-while-off files.
 *
 * This is the single shared form of the `(existingPaths)` factory the
 * snapshots.persistence and persistence.service.tombstone suites each
 * re-declared. epic-14 decision #31 kept them split because tombstone added a
 * `t` translation stub that snapshots.persistence omitted; T07 verified that
 * `plugin.t` is only ever read on the invalid-exclude-pattern warning path,
 * which neither suite exercises, so the stub is a no-op for both and the
 * factory is safe to unify (echoing translation keys like
 * {@link makeSnapshotsService}).
 *
 * @param {string[]} existingPaths - Vault paths that resolve to a live file
 * @return {SnapshotsService} A service over the simulated vault index
 */
export const makeSnapshotsServiceWithPaths = (existingPaths: string[] = []): SnapshotsService => {
  const present: Set<string> = new Set(existingPaths);

  const plugin = {
    getActiveEditorView: (): undefined => undefined,
    getFileByPath: (path: string): TFile | null => (present.has(path) ? makeFile(path) : null),
    t: (key: string): string => key,
  } as unknown as PluginArg;

  return new SnapshotsService(plugin);
};
