import { MS_PER_DAY, VERSION_KEYFRAME_INTERVAL } from '@/consts';
import { FileVersion } from '@/snapshots/file.version';
import type { SnapshotCaptureOptions, VersionCaptureContext } from '@/types';

/**
 * Owns the version-timeline concern extracted from FileSnapshot: the `versions`
 * array (oldest first), the capture cadence, the no-op dedup, the append, and
 * the age/count eviction. The array and the cadence counters (`editsSinceVersion`,
 * `lastVersionAt`) live together here; no method threads the array in as a
 * parameter. FileSnapshot holds one instance and exposes it as the
 * `snapshot.timeline` sub-object; callers reach version queries through it, while
 * the façade only rewires its own composite operations (capture, adoptHistory,
 * serialization) to read and write this owner.
 */
export class VersionTimeline {
  /**
   * The intermediate versions, oldest first. Each entry is a frozen copy of the
   * file content at the moment it was captured; the original baseline and the
   * live state are not stored here, only the points in between. Owned outright by
   * the timeline: reads leave through the readonly `getStoredVersions()` view and
   * the newest-first `getVersions()` copy, writes go through capture/restore/adopt
   * so external code can neither reassign nor splice it.
   */
  protected versions: FileVersion[] = [];

  /**
   * Number of state updates accumulated since the last captured version. Drives
   * the edit-count gate of the capture cadence so versions are taken every N
   * edits rather than on every keystroke-driven update.
   */
  protected editsSinceVersion: number = 0;

  /**
   * Timestamp (ms) of the last captured version, or the timeline's creation time
   * when no version has been captured yet. Drives the time gate of the cadence.
   */
  protected lastVersionAt: number = Date.now();

  /**
   * Records that the document changed since the last captured version and, when
   * the configured cadence is met, freezes the previous state as a new
   * intermediate version on the owned timeline.
   *
   * The current (newest) state is never stored as a version: the history modal
   * always has the live state available separately. A no-op capture is skipped:
   * when the content to freeze equals the most recent stored version (or the
   * history baseline when none exist), no version is pushed. A label-carrying
   * capture is treated as a pinned marker: it bypasses the duplicate-skip so
   * the user-supplied tag is always recorded, and the resulting version is exempt
   * from eviction.
   *
   * @param {VersionCaptureContext} context - The history baseline, line break,
   *   and cadence/retention options
   * @param {string[]} previousLines - The content to freeze (pre-edit state)
   * @param {boolean} force - Capture regardless of the cadence gates
   * @param {string} label - Optional user-supplied tag that pins the version
   * @return {FileVersion | null} The captured version, or null when none was taken
   */
  public capture(
    context: VersionCaptureContext,
    previousLines: string[],
    force: boolean = false,
    label?: string,
  ): FileVersion | null {
    const { options } = context;

    if (!options?.enabled || !Array.isArray(previousLines)) {
      return null;
    }

    const labeled: boolean = typeof label === 'string' && label.length > 0;

    this.editsSinceVersion += 1;

    if (!force && !this.isVersionDue(options)) {
      return null;
    }

    /**
     * Skip a capture that would duplicate the latest stored version, or the
     * history baseline when the timeline is still empty. The cadence counters are
     * intentionally left untouched so the next genuinely diverging edit is
     * captured immediately rather than waiting out the gate again. A label
     * bypasses the dedup: an intentional marker must land even on no-op content.
     */
    if (!labeled && this.isDuplicateOfLatest(previousLines, context.historyBaseline, context.lineBreak)) {
      return null;
    }

    const version: FileVersion = new FileVersion(previousLines, undefined, label);

    this.pushVersion(version, options);

    return version;
  }

  /**
   * Whether the given content equals the latest stored version, or the history
   * baseline when no version exists yet. Used to skip a no-op capture so the
   * timeline never holds an adjacent duplicate or a first version identical to
   * the original.
   *
   * @param {string[]} lines - The candidate content to freeze
   * @param {string} historyBaseline - The empty-timeline dedup reference
   * @param {string} lineBreak - The line break used to join candidate content
   * @return {boolean} True when the candidate duplicates the latest base
   */
  protected isDuplicateOfLatest(lines: string[], historyBaseline: string, lineBreak: string): boolean {
    const candidate: string = lines.join(lineBreak);
    const latest: FileVersion | undefined = this.versions[this.versions.length - 1];
    /**
     * The timeline belongs to the history side, so the empty-timeline reference
     * is the history baseline (the persisted original), not the marker baseline.
     */
    const reference: string = latest ? latest.getContent(lineBreak) : historyBaseline;

    return candidate === reference;
  }

  /**
   * Decides whether the cadence gates allow a new version right now. Either gate
   * (edit count or elapsed time) can trigger a capture; a gate set to 0 is
   * disabled and never triggers on its own.
   *
   * @param {SnapshotCaptureOptions} options - The capture cadence configuration
   * @return {boolean} True if a version should be captured
   */
  protected isVersionDue(options: SnapshotCaptureOptions): boolean {
    const byEdits: boolean = options.editThreshold > 0 && this.editsSinceVersion >= options.editThreshold;
    const byTime: boolean = options.intervalMs > 0 && (Date.now() - this.lastVersionAt) >= options.intervalMs;

    return byEdits || byTime;
  }

  /**
   * Appends a version to the owned timeline, resets the cadence counters, and
   * trims the timeline by evicting expired then excess entries.
   *
   * @param {FileVersion} version - The version to append
   * @param {SnapshotCaptureOptions} options - The capture cadence and retention caps
   */
  protected pushVersion(version: FileVersion, options: SnapshotCaptureOptions): void {
    this.versions.push(version);

    this.editsSinceVersion = 0;
    this.lastVersionAt = version.timestamp;

    this.evictVersions(options);
  }

  /**
   * Trims the owned timeline to its retention caps, age first then count,
   * mirroring the JetBrains Local History model where age is the primary bound
   * and the count is a safety cap. Versions older than maxVersionAgeDays are
   * dropped regardless of count, then any beyond maxVersions are dropped
   * regardless of age. A cap of 0 disables that dimension. Because versions are
   * appended oldest-first, both passes evict from the front of the array.
   *
   * Labeled versions are pinned: they are never dropped by either pass, so
   * an intentional user marker survives both the age window and the count cap.
   * The count cap counts only unlabeled entries, so a labeled version does not
   * push an unlabeled one out either.
   *
   * @param {SnapshotCaptureOptions} options - The retention caps to apply
   */
  protected evictVersions(options: SnapshotCaptureOptions): void {
    const maxAgeDays: number = options?.maxVersionAgeDays;

    if (typeof maxAgeDays === 'number' && maxAgeDays > 0) {
      const oldest: number = Date.now() - (maxAgeDays * MS_PER_DAY);

      this.versions = this.versions.filter(
        (version: FileVersion): boolean => version.isLabeled() || version.timestamp >= oldest,
      );
    }

    const maxVersions: number = options?.maxVersions;

    if (typeof maxVersions === 'number' && maxVersions > 0) {
      const unlabeled: number = this.versions.reduce(
        (count: number, version: FileVersion): number => count + (version.isLabeled() ? 0 : 1),
        0,
      );

      let toDrop: number = unlabeled - maxVersions;

      if (toDrop > 0) {
        this.versions = this.versions.filter((version: FileVersion): boolean => {
          if (toDrop <= 0 || version.isLabeled()) {
            return true;
          }

          toDrop -= 1;

          return false;
        });
      }
    }
  }

  /**
   * Returns the intermediate versions, newest first, as a copy so callers cannot
   * mutate the owned timeline.
   *
   * @return {FileVersion[]} The timeline versions, newest first
   */
  public getVersions(): FileVersion[] {
    return [...this.versions].reverse();
  }

  /**
   * Returns the owned timeline in stored (oldest-first) order as a readonly live
   * view. Distinct from getVersions() (a newest-first copy the UI rails consume):
   * the serializer, the folder timeline, and the folder delta read the versions
   * in capture order without paying for a reversal, while the readonly type keeps
   * them from mutating the owner's array.
   *
   * @return {readonly FileVersion[]} The stored versions, oldest first
   */
  public getStoredVersions(): readonly FileVersion[] {
    return this.versions;
  }

  /**
   * Finds an intermediate version by its id.
   *
   * @param {string} id - The version id to look up
   * @return {FileVersion | null} The matching version, or null if absent
   */
  public getVersion(id: string): FileVersion | null {
    return this.versions.find((version: FileVersion): boolean => version.id === id) ?? null;
  }

  /**
   * Removes a single intermediate version from the owned timeline by its id in
   * place, leaving every other version untouched. Used by the history modal to
   * prune one captured point without wiping the whole timeline.
   *
   * @param {string} id - The id of the version to remove
   * @return {boolean} True if a version was removed, false if no id matched
   */
  public removeVersion(id: string): boolean {
    const index: number = this.versions.findIndex((version: FileVersion): boolean => version.id === id);

    if (index === -1) {
      return false;
    }

    this.versions.splice(index, 1);

    return true;
  }

  /**
   * Whether the owned timeline has any intermediate versions.
   *
   * @return {boolean} True when at least one version exists
   */
  public hasVersions(): boolean {
    return this.versions.length > 0;
  }

  /**
   * Restores a persisted timeline: adopts the decoded versions as the owned array
   * and seeds both cadence gates from them so the capture cadence is continuous
   * across a restart (the time gate from the newest version's timestamp, the edit
   * gate from the current keyframe group). Used by FileSnapshot.fromJSON.
   *
   * @param {FileVersion[]} versions - The decoded timeline, oldest first
   */
  public restore(versions: FileVersion[]): void {
    this.versions = versions;
    this.seedLastVersionAt();
    this.seedEditsSinceVersion();
  }

  /**
   * Replaces the owned timeline with an externally-provided array without
   * touching the cadence gates. Used by FileSnapshot.adoptHistory (restore path)
   * and the tombstone builder, which hand over an already-copied timeline and
   * must not disturb the capture cadence the way a fresh restore does.
   *
   * @param {FileVersion[]} versions - The timeline to adopt, oldest first
   */
  public adopt(versions: FileVersion[]): void {
    this.versions = versions;
  }

  /**
   * Seeds the time-gate counter from the owned versions on restore so the cadence
   * is continuous across restarts. Without this the constructor-seeded
   * `lastVersionAt` (set to `Date.now()` at restore time) would reset the time
   * gate on every launch, so a file that already had a version captured an hour
   * before the restart would not be eligible for the next time-gated capture until
   * the full interval elapsed again.
   *
   * The seed is derived from the newest version's timestamp (the value the gate
   * normally tracks after a capture). When the timeline is empty there is no prior
   * capture to anchor against, so the constructor default stays in place. Only
   * timestamps that strictly precede the current default are accepted, so a
   * corrupt future-dated entry cannot push the gate forward.
   */
  protected seedLastVersionAt(): void {
    if (this.versions.length === 0) {
      return;
    }

    const newest: FileVersion = this.versions[this.versions.length - 1];
    const timestamp: number = newest?.timestamp;

    if (typeof timestamp !== 'number' || timestamp >= this.lastVersionAt) {
      return;
    }

    this.lastVersionAt = timestamp;
  }

  /**
   * Seeds the edit-count gate from the owned versions on restore so the capture
   * cadence is not artificially reset to 0 on every restart (A5). Without this, a
   * file with an existing timeline always restarts with `editsSinceVersion = 0`,
   * effectively delaying the first post-restore version capture by a full
   * `editThreshold` count even though several versions may already have been taken
   * in the current keyframe group.
   *
   * The seed is derived from the number of persisted versions in the current
   * keyframe group: `versions.length % VERSION_KEYFRAME_INTERVAL`. A group starts
   * at index 0, 25, 50, etc. (one full keyframe interval apart), so a timeline of
   * N versions has accumulated N % 25 entries since the most recent keyframe
   * boundary. When the timeline is empty or the length is an exact multiple of the
   * interval (i.e., the last version IS a keyframe), the count is 0 and the gate is
   * not advanced.
   *
   * The seeded value is the maximum of the computed count and any existing
   * `editsSinceVersion` so a future call cannot deflate a counter that was already
   * advanced by a capture since object creation.
   */
  protected seedEditsSinceVersion(): void {
    if (this.versions.length === 0) {
      return;
    }

    const count: number = this.versions.length % VERSION_KEYFRAME_INTERVAL;

    if (count === 0) {
      return;
    }

    this.editsSinceVersion = Math.max(this.editsSinceVersion, count);
  }
}
