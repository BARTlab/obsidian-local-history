/**
 * One in-memory index entry for a persisted shard: the on-disk filename to write
 * or remove it under, and a >=64-bit content digest of its serialized snapshot.
 * The save path diffs the live digest against this to write only
 * changed shards, and reuses `name` for collision-aware naming so two distinct
 * notes never share a filename.
 */
export interface ShardIndexEntry {
  name: string;
  digest: string;
}
