import { SnapshotsService } from '@/services/snapshots.service';

/**
 * Shared service factories for the test suite. These replace the per-file copies
 * that re-declared the same `SnapshotsService` construction across suites. The
 * intent is setup-only: nothing here changes what a test asserts, it only
 * removes the duplicated construction.
 *
 * Only genuinely identical factories live here. File-specific service factories
 * (i18n, settings, resilience, the settings-aware and existing-paths variants)
 * stay local because they construct different service classes or have
 * file-specific plugin wiring and are not duplication.
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
