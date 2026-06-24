import { isString } from 'lodash-es';

import { Inject } from '@/decorators/inject.decorator';
import type LineChangeTrackerPlugin from '@/main';
import type { SettingsService } from '@/services/settings.service';
import type { SnapshotsService } from '@/services/snapshots.service';
import { TOKENS } from '@/services/tokens';
import type { FileSnapshot } from '@/snapshots/file.snapshot';
import type { FileVersion } from '@/snapshots/file.version';
import type { Service, SnapshotCaptureOptions, VersionRemoveResult, VersionRestoreResult } from '@/types';
import type { TFile } from 'obsidian';

/**
 * Shared owner of restore/remove/put-label actions on a file's version timeline.
 *
 * Both the history modal and the upcoming recent-changes panel (D3) need the
 * same three operations against a {@link FileSnapshot}; routing them through one
 * service is the single implementation D5 requires, so behaviour cannot drift
 * between surfaces. The service stays Obsidian-DOM-free: callers handle the
 * confirmation prompts and the visual refresh, and this layer mutates the model
 * plus the vault file through the existing {@link SnapshotsService} primitives.
 *
 * @implements {Service}
 */
export class VersionActionsService implements Service {
  /**
   * Service for managing file snapshots. Used to resolve a file's snapshot, to
   * write the reverted content via applyContent, and to notify subscribers when
   * the version list changes (forceUpdate after a remove).
   */
  @Inject(TOKENS.snapshots)
  protected snapshotsService!: SnapshotsService;

  /**
   * Settings service the put-label path consults to pass the same retention
   * caps to captureVersion that the change-detector uses, so eviction stays
   * consistent across capture sources. The cadence gates (interval/edit count)
   * do not apply because a labeled capture forces (D6).
   */
  @Inject(TOKENS.settings)
  protected settingsService!: SettingsService;

  /**
   * Creates a new instance of VersionActionsService.
   *
   * @param {LineChangeTrackerPlugin} plugin - The plugin instance
   */
  public constructor(
    protected plugin: LineChangeTrackerPlugin,
  ) {
  }

  /**
   * Lifecycle hook invoked during plugin init. The service is fully usable as
   * soon as its dependencies resolve through the @Inject decorators, so nothing
   * is set up here; the hook is kept so the class satisfies the Service shape
   * the DI container expects, matching the other action-only services.
   */
  public init(): void {
  }

  /**
   * Rewrites the file backing the snapshot to the captured content of the given
   * version, mirroring the modal's previous behaviour: the version timeline and
   * the history baseline are kept (so the prior content simply becomes the next
   * captured version on the following edit), and the write reuses
   * SnapshotsService.applyContent so the tracker, the cached state, and the
   * gutter highlights stay consistent. A no-op when the content already matches
   * the version, the snapshot is missing, or the version id is unknown.
   *
   * @param {TFile | null} file - The file whose snapshot owns the version
   * @param {string} versionId - The id of the version to restore
   * @return {Promise<VersionRestoreResult>} Whether the write happened
   */
  public async restoreSelected(file: TFile | null, versionId: string): Promise<VersionRestoreResult> {
    const snapshot: FileSnapshot | null = this.snapshotsService.getOne(file);
    const target: TFile | null = snapshot?.file ?? null;

    if (!snapshot || !target) {
      return { applied: false };
    }

    const version: FileVersion | null = snapshot.getVersion(versionId);

    if (!version) {
      return { applied: false };
    }

    const baseLines: string[] = version.getLines();
    const currentLines: string[] = snapshot.getLastStateLines();

    if (baseLines.join(snapshot.lineBreak) === currentLines.join(snapshot.lineBreak)) {
      return { applied: false };
    }

    await this.snapshotsService.applyContent(target, baseLines, {
      start: 0,
      removeCount: currentLines.length,
      newLines: baseLines,
    });

    return { applied: true };
  }

  /**
   * Drops the given version from the snapshot's timeline, leaving the history
   * baseline and the file content untouched. Returns the id of the version the
   * caller should focus next: the newer neighbour (toward the top of the rail),
   * falling back to the older one, then null when the timeline becomes empty.
   * A no-op when the snapshot is missing or the version id is unknown.
   *
   * @param {TFile | null} file - The file whose snapshot owns the version
   * @param {string} versionId - The id of the version to remove
   * @return {VersionRemoveResult} Whether a version was removed and the next id
   */
  public removeSelected(file: TFile | null, versionId: string): VersionRemoveResult {
    const snapshot: FileSnapshot | null = this.snapshotsService.getOne(file);

    if (!snapshot) {
      return { removed: false, nextId: null };
    }

    /**
     * Resolve the next focus from the displayed list BEFORE removing. getVersions
     * is newest-first, so a row's older neighbour sits at the next index; we
     * prefer the older one (continues a downward walk after Delete) and fall
     * back to the newer one when nothing is below.
     */
    const visible: FileVersion[] = snapshot.getVersions();
    const index: number = visible.findIndex((version: FileVersion): boolean => version.id === versionId);
    const nextId: string | null =
      index === -1 ? null : visible[index + 1]?.id ?? visible[index - 1]?.id ?? null;

    if (!snapshot.removeVersion(versionId)) {
      return { removed: false, nextId: null };
    }

    this.snapshotsService.forceUpdate();

    return { removed: true, nextId };
  }

  /**
   * Captures a pinned, labeled version of the file's current content. The label
   * is trimmed of surrounding whitespace; an empty result is a no-op so a
   * cancel-equivalent input does not pollute the timeline. The capture forces
   * past the cadence gates and the duplicate-skip (D6), so an intentional marker
   * always lands even when nothing has changed since the latest version. The
   * snapshot's existing retention caps still apply, but labeled entries are
   * pinned against eviction (D6/D10).
   *
   * @param {TFile | null} file - The file to label
   * @param {string} label - The user-supplied tag
   * @return {FileVersion | null} The captured version, or null on a no-op
   */
  public putLabel(file: TFile | null, label: string): FileVersion | null {
    const snapshot: FileSnapshot | null = this.snapshotsService.getOne(file);
    const trimmed: string = isString(label) ? label.trim() : '';

    if (!snapshot || trimmed.length === 0) {
      return null;
    }

    /**
     * A labeled capture is an intentional marker (D6), so the cadence "enabled"
     * gate is forced on regardless of the user's snapshots setting: a user can
     * turn off automatic capture but still pin a deliberate point. The retention
     * caps stay as configured; labeled versions are pinned against eviction.
     */
    const captured: FileVersion | null = snapshot.captureVersion(
      snapshot.getLastStateLines(),
      { ...this.getCaptureOptions(), enabled: true },
      true,
      trimmed,
    );

    if (captured) {
      this.snapshotsService.forceUpdate();
    }

    return captured;
  }

  /**
   * Sets a custom label on an EXISTING captured version, turning that version
   * into a pinned marker in place (D1/D6). This is distinct from
   * {@link putLabel}, which pins the file's CURRENT content as a NEW version:
   * here the label lands on the version the caller picked (a panel row, or the
   * modal's selected base), so the marker tags the slice the user pointed at
   * rather than the latest state. The label is trimmed; an empty result is a
   * no-op so a cancel-equivalent input cannot blank out a version. Labeling
   * pins the version against the duplicate-skip and the age/count eviction
   * passes (isLabeled). The mutation is persisted and subscribers are notified
   * through forceUpdate. A no-op when the snapshot is missing or the version id
   * is unknown.
   *
   * @param {TFile | null} file - The file whose snapshot owns the version
   * @param {string} versionId - The id of the existing version to label
   * @param {string} label - The user-supplied tag
   * @return {FileVersion | null} The labeled version, or null on a no-op
   */
  public label(file: TFile | null, versionId: string, label: string): FileVersion | null {
    const snapshot: FileSnapshot | null = this.snapshotsService.getOne(file);
    const trimmed: string = isString(label) ? label.trim() : '';

    if (!snapshot || trimmed.length === 0) {
      return null;
    }

    const version: FileVersion | null = snapshot.getVersion(versionId);

    if (!version) {
      return null;
    }

    version.label = trimmed;
    this.snapshotsService.forceUpdate();

    return version;
  }

  /**
   * Reads the current intermediate-snapshot cadence settings into a plain
   * options object for the snapshot model. Mirrors the change-detector's
   * helper so eviction caps stay aligned across both capture sources; the
   * cadence gates themselves do not affect a forced labeled capture.
   *
   * @return {SnapshotCaptureOptions} The capture cadence configuration
   */
  protected getCaptureOptions(): SnapshotCaptureOptions {
    return {
      enabled: this.settingsService.value('snapshots.enabled'),
      intervalMs: this.settingsService.value('snapshots.intervalMs'),
      editThreshold: this.settingsService.value('snapshots.editThreshold'),
      maxVersions: this.settingsService.value('snapshots.maxVersions'),
      maxVersionAgeDays: this.settingsService.value('snapshots.maxVersionAgeDays'),
    };
  }
}
