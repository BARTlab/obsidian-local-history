import { MS_PER_DAY } from '@/consts';
import type { RetentionCaps } from '@/persistence/retention-policy.types';
import type { SerializedFileSnapshot } from '@/types';

/**
 * Stateless policy that prunes a list of serialized snapshots down to the set
 * worth keeping on disk. It holds no state: every method takes the snapshots and
 * the caps as explicit arguments, matching the stateless-operator convention of
 * its persistence-domain siblings (VersionCodec, ShardNameHelper). Extracted
 * from PersistenceService so the two-bucket cap math is deep and unit-testable
 * without a settings mock or any disk dependency.
 */
export class RetentionPolicy {
  /**
   * Applies the retention caps to a list of serialized snapshots.
   * Runs two independent passes: live snapshots are bounded by COUNT only
   * (`maxEntries`) and are deliberately NOT pruned by age, while tombstones
   * (entries with `deletedTimestamp` set) keep BOTH caps (`maxDeletedEntries` /
   * `maxDeletedAgeDays`). A cap of 0 disables that dimension for its bucket.
   *
   * Live files are no longer age-pruned (the prior contract dropped live
   * entries past a `maxAgeDays`). That dropped age dimension caused a
   * total-history wipe: in an idle vault every live snapshot eventually ages
   * past `maxAgeDays`, retention then returned an empty set, and the save path
   * cleared the entire shard directory even though those files still exist and
   * still hold in-memory history. Bounding live files by count (and per-file
   * version caps elsewhere) keeps storage in check without ever expiring a
   * still-present file's history purely because it is old. A deleted file's
   * recoverability window is a real policy, so tombstones still expire by age.
   *
   * Byte-budget (global maxStorageBytes) is intentionally out of scope. The
   * existing multi-dimensional count-cap policy (maxEntries, maxDeletedEntries,
   * maxVersions) is accepted as the retention strategy. A byte-budget
   * dimension adds implementation complexity - it requires summing encoded sizes
   * across shards and is sensitive to codec changes - without meaningfully
   * improving the user-observable storage behaviour that count caps already bound.
   *
   * @param {SerializedFileSnapshot[]} snapshots - The raw persisted snapshots
   * @param {RetentionCaps} caps - The count/age caps read from settings
   * @return {SerializedFileSnapshot[]} The retained subset, newest first
   */
  public static apply(snapshots: SerializedFileSnapshot[], caps: RetentionCaps): SerializedFileSnapshot[] {
    if (!Array.isArray(snapshots)) {
      return [];
    }

    const live: SerializedFileSnapshot[] = [];
    const tombstones: SerializedFileSnapshot[] = [];

    for (const item of snapshots) {
      if (!item) {
        continue;
      }

      if (typeof item.deletedTimestamp === 'number') {
        tombstones.push(item);
      } else {
        live.push(item);
      }
    }

    const keptLive: SerializedFileSnapshot[] = RetentionPolicy.applyBucket(
      live,
      caps.maxEntries,
      /**
       * Age cap forced to 0 (disabled) for live files on purpose: a still-present
       * file must never lose its history just because it is old, otherwise an idle
       * vault's entire on-disk history is eventually evicted and wiped. Only the
       * count cap bounds live files here; the age cap is left to govern tombstones
       * below.
       */
      0,
      (item: SerializedFileSnapshot): number => item.timestamp,
    );

    const keptTombstones: SerializedFileSnapshot[] = RetentionPolicy.applyBucket(
      tombstones,
      caps.maxDeletedEntries,
      caps.maxDeletedAgeDays,
      /**
       * Age a tombstone by its deletion time so the policy answers "how long do
       * we keep deleted-file recoverability" rather than "how stale was the file
       * when it was deleted".
       */
      (item: SerializedFileSnapshot): number => item.deletedTimestamp ?? item.timestamp,
    );

    return [...keptLive, ...keptTombstones];
  }

  /**
   * Runs a single retention pass on a bucket of serialized snapshots, dropping
   * entries older than `maxAgeDays` (when > 0) and then capping by `maxEntries`
   * (when > 0). The bucket's "age" is read through the supplied accessor so
   * tombstones age by `deletedTimestamp`. Callers pass `maxAgeDays = 0` to
   * disable age pruning entirely: the live bucket does this so a still-present
   * file is never expired by age (see {@link RetentionPolicy.apply}).
   *
   * @param {SerializedFileSnapshot[]} bucket - The bucket to prune (not mutated)
   * @param {number} maxEntries - Size cap for this bucket (0 disables)
   * @param {number} maxAgeDays - Age cap in days for this bucket (0 disables)
   * @param {(item: SerializedFileSnapshot) => number} ageOf - Reads the age timestamp from an item
   * @return {SerializedFileSnapshot[]} The retained subset, newest first
   */
  protected static applyBucket(
    bucket: SerializedFileSnapshot[],
    maxEntries: number,
    maxAgeDays: number,
    ageOf: (item: SerializedFileSnapshot) => number,
  ): SerializedFileSnapshot[] {
    const oldest: number = maxAgeDays > 0 ? Date.now() - (maxAgeDays * MS_PER_DAY) : 0;

    let kept: SerializedFileSnapshot[] = bucket.filter((item: SerializedFileSnapshot): boolean =>
      oldest === 0 || ageOf(item) >= oldest
    );

    // Newest first so the size cap evicts the stalest entries.
    kept.sort((a: SerializedFileSnapshot, b: SerializedFileSnapshot): number => ageOf(b) - ageOf(a));

    if (maxEntries > 0 && kept.length > maxEntries) {
      kept = kept.slice(0, maxEntries);
    }

    return kept;
  }
}
