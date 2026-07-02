import type { SerializedShard } from '@/types';

/**
 * One enumerated shard: its on-disk filename (the read-time index key) paired
 * with the parsed, validated payload. `readAll` returns these so the caller can
 * seed its in-memory path-to-shard index without re-listing.
 */
export interface LoadedShard {
  name: string;
  shard: SerializedShard;
}
