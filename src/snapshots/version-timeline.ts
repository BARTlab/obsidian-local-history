import { MS_PER_DAY, VERSION_KEYFRAME_INTERVAL } from '@/consts';
import { FileVersion } from '@/snapshots/file.version';
import type { SnapshotCaptureOptions, VersionCaptureContext, VersionCaptureResult } from '@/types';
import { isArray, isNumber, isString } from 'lodash-es';

/**
 * Stateless operator owning the version-timeline concern extracted from
 * FileSnapshot: the capture cadence, the no-op dedup, the append, and the
 * age/count eviction. It does NOT hold the `versions` array (that stays a
 * writable façade field external code assigns and mutates); every operation
 * takes the façade's array as an explicit argument and returns the result the
 * façade writes back. The cadence counters (`editsSinceVersion`, `lastVersionAt`)
 * are the only mutable state this collaborator owns, because they are referenced
 * nowhere outside the timeline logic.
 */
export class VersionTimeline {
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
   * intermediate version on the timeline.
   *
   * The current (newest) state is never stored as a version: the history modal
   * always has the live state available separately. A no-op capture is skipped:
   * when the content to freeze equals the most recent stored version (or the
   * history baseline when none exist), no version is pushed. A label-carrying
   * capture is treated as a pinned marker: it bypasses the duplicate-skip so
   * the user-supplied tag is always recorded, and the resulting version is exempt
   * from eviction.
   *
   * @param {VersionCaptureContext} context - The façade-owned timeline, history
   *   baseline, line break, and cadence/retention options
   * @param {string[]} previousLines - The content to freeze (pre-edit state)
   * @param {boolean} force - Capture regardless of the cadence gates
   * @param {string} label - Optional user-supplied tag that pins the version
   * @return {VersionCaptureResult} The captured version (or null) and the
   *   timeline array the façade must adopt
   */
  public capture(
    context: VersionCaptureContext,
    previousLines: string[],
    force: boolean = false,
    label?: string,
  ): VersionCaptureResult {
    const { versions, options } = context;

    if (!options?.enabled || !isArray(previousLines)) {
      return { version: null, versions };
    }

    const labeled: boolean = isString(label) && label.length > 0;

    this.editsSinceVersion += 1;

    if (!force && !this.isVersionDue(options)) {
      return { version: null, versions };
    }

    /**
     * Skip a capture that would duplicate the latest stored version, or the
     * history baseline when the timeline is still empty. The cadence counters are
     * intentionally left untouched so the next genuinely diverging edit is
     * captured immediately rather than waiting out the gate again. A label
     * bypasses the dedup: an intentional marker must land even on no-op content.
     */
    if (!labeled && this.isDuplicateOfLatest(versions, previousLines, context.historyBaseline, context.lineBreak)) {
      return { version: null, versions };
    }

    const version: FileVersion = new FileVersion(previousLines, undefined, label);

    return { version, versions: this.pushVersion(versions, version, options) };
  }

  /**
   * Whether the given content equals the latest stored version, or the history
   * baseline when no version exists yet. Used to skip a no-op capture so the
   * timeline never holds an adjacent duplicate or a first version identical to
   * the original.
   *
   * @param {FileVersion[]} versions - The current timeline, oldest first
   * @param {string[]} lines - The candidate content to freeze
   * @param {string} historyBaseline - The empty-timeline dedup reference
   * @param {string} lineBreak - The line break used to join candidate content
   * @return {boolean} True when the candidate duplicates the latest base
   */
  protected isDuplicateOfLatest(
    versions: FileVersion[],
    lines: string[],
    historyBaseline: string,
    lineBreak: string,
  ): boolean {
    const candidate: string = lines.join(lineBreak);
    const latest: FileVersion | undefined = versions[versions.length - 1];
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
   * Appends a version to the timeline, resets the cadence counters, and trims the
   * timeline by evicting expired then excess entries. Returns the resulting array
   * (the eviction may filter it) for the façade to store.
   *
   * @param {FileVersion[]} versions - The current timeline, oldest first
   * @param {FileVersion} version - The version to append
   * @param {SnapshotCaptureOptions} options - The capture cadence and retention caps
   * @return {FileVersion[]} The timeline array after append and eviction
   */
  protected pushVersion(
    versions: FileVersion[],
    version: FileVersion,
    options: SnapshotCaptureOptions,
  ): FileVersion[] {
    versions.push(version);

    this.editsSinceVersion = 0;
    this.lastVersionAt = version.timestamp;

    return this.evictVersions(versions, options);
  }

  /**
   * Trims the timeline to its retention caps, age first then count, mirroring the
   * JetBrains Local History model where age is the primary bound and the count is
   * a safety cap. Versions older than maxVersionAgeDays are dropped regardless of
   * count, then any beyond maxVersions are dropped regardless of age. A cap of 0
   * disables that dimension. Because versions are appended oldest-first, both
   * passes evict from the front of the array.
   *
   * Labeled versions are pinned: they are never dropped by either pass, so
   * an intentional user marker survives both the age window and the count cap.
   * The count cap counts only unlabeled entries, so a labeled version does not
   * push an unlabeled one out either.
   *
   * @param {FileVersion[]} versions - The timeline to trim, oldest first
   * @param {SnapshotCaptureOptions} options - The retention caps to apply
   * @return {FileVersion[]} The timeline array after eviction
   */
  protected evictVersions(versions: FileVersion[], options: SnapshotCaptureOptions): FileVersion[] {
    let result: FileVersion[] = versions;
    const maxAgeDays: number = options?.maxVersionAgeDays;

    if (isNumber(maxAgeDays) && maxAgeDays > 0) {
      const oldest: number = Date.now() - (maxAgeDays * MS_PER_DAY);

      result = result.filter(
        (version: FileVersion): boolean => version.isLabeled() || version.timestamp >= oldest,
      );
    }

    const maxVersions: number = options?.maxVersions;

    if (isNumber(maxVersions) && maxVersions > 0) {
      const unlabeled: number = result.reduce(
        (count: number, version: FileVersion): number => count + (version.isLabeled() ? 0 : 1),
        0,
      );

      let toDrop: number = unlabeled - maxVersions;

      if (toDrop > 0) {
        result = result.filter((version: FileVersion): boolean => {
          if (toDrop <= 0 || version.isLabeled()) {
            return true;
          }

          toDrop -= 1;

          return false;
        });
      }
    }

    return result;
  }

  /**
   * Returns the intermediate versions, newest first, as a copy so callers cannot
   * mutate the timeline.
   *
   * @param {FileVersion[]} versions - The timeline, oldest first
   * @return {FileVersion[]} The timeline versions, newest first
   */
  public getVersions(versions: FileVersion[]): FileVersion[] {
    return [...versions].reverse();
  }

  /**
   * Finds an intermediate version by its id.
   *
   * @param {FileVersion[]} versions - The timeline to search
   * @param {string} id - The version id to look up
   * @return {FileVersion | null} The matching version, or null if absent
   */
  public getVersion(versions: FileVersion[], id: string): FileVersion | null {
    return versions.find((version: FileVersion): boolean => version.id === id) ?? null;
  }

  /**
   * Removes a single intermediate version from the timeline by its id in place,
   * leaving every other version untouched. Used by the history modal to prune one
   * captured point without wiping the whole timeline.
   *
   * @param {FileVersion[]} versions - The timeline to mutate, oldest first
   * @param {string} id - The id of the version to remove
   * @return {boolean} True if a version was removed, false if no id matched
   */
  public removeVersion(versions: FileVersion[], id: string): boolean {
    const index: number = versions.findIndex((version: FileVersion): boolean => version.id === id);

    if (index === -1) {
      return false;
    }

    versions.splice(index, 1);

    return true;
  }

  /**
   * Whether the timeline has any intermediate versions.
   *
   * @param {FileVersion[]} versions - The timeline to inspect
   * @return {boolean} True when at least one version exists
   */
  public hasVersions(versions: FileVersion[]): boolean {
    return versions.length > 0;
  }

  /**
   * Seeds the time-gate counter on restore so the cadence is continuous across
   * restarts. Without this the constructor-seeded `lastVersionAt`
   * (set to `Date.now()` at restore time) would reset the time gate on every
   * launch, so a file that already had a version captured an hour before the
   * restart would not be eligible for the next time-gated capture until the
   * full interval elapsed again.
   *
   * The seed is derived from the newest version's timestamp (the value the
   * gate normally tracks after a capture). When the timeline is empty there is
   * no prior capture to anchor against, so the constructor default stays in
   * place. Only timestamps that strictly precede the current default are
   * accepted, so a corrupt future-dated entry cannot push the gate forward.
   *
   * @param {FileVersion[]} versions - The restored timeline, oldest first
   */
  public seedLastVersionAtFromVersions(versions: FileVersion[]): void {
    if (!isArray(versions) || versions.length === 0) {
      return;
    }

    const newest: FileVersion = versions[versions.length - 1];
    const timestamp: number = newest?.timestamp;

    if (!isNumber(timestamp) || timestamp >= this.lastVersionAt) {
      return;
    }

    this.lastVersionAt = timestamp;
  }

  /**
   * Seeds the edit-count gate on restore so the capture cadence is not
   * artificially reset to 0 on every restart (A5). Without this, a file with
   * an existing timeline always restarts with `editsSinceVersion = 0`,
   * effectively delaying the first post-restore version capture by a full
   * `editThreshold` count even though several versions may already have been
   * taken in the current keyframe group.
   *
   * The seed is derived from the number of persisted versions in the current
   * keyframe group: `versions.length % VERSION_KEYFRAME_INTERVAL`. A group
   * starts at index 0, 25, 50, etc. (one full keyframe interval apart), so
   * a timeline of N versions has accumulated N % 25 entries since the most
   * recent keyframe boundary. When the timeline is empty or the length is an
   * exact multiple of the interval (i.e., the last version IS a keyframe),
   * the count is 0 and the gate is not advanced.
   *
   * The seeded value is the maximum of the computed count and any existing
   * `editsSinceVersion` so a future call cannot deflate a counter that was
   * already advanced by a capture since object creation.
   *
   * @param {FileVersion[]} versions - The restored timeline, oldest first
   */
  public seedEditsSinceVersionFromVersions(versions: FileVersion[]): void {
    if (!isArray(versions) || versions.length === 0) {
      return;
    }

    const count: number = versions.length % VERSION_KEYFRAME_INTERVAL;

    if (count === 0) {
      return;
    }

    this.editsSinceVersion = Math.max(this.editsSinceVersion, count);
  }
}
