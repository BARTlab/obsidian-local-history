/**
 * The retention caps that bound how much history is kept, read from settings by
 * the caller and passed in so the policy itself holds no service state. Live
 * files are bounded by count only (`maxEntries`); tombstones (deleted files)
 * keep both a count cap (`maxDeletedEntries`) and an age cap
 * (`maxDeletedAgeDays`). A cap of 0 disables that dimension. There is
 * deliberately no live-file age cap: a still-present file must never lose its
 * history purely because it is old (see {@link RetentionPolicy.apply}).
 */
export interface RetentionCaps {
  maxEntries: number;
  maxDeletedEntries: number;
  maxDeletedAgeDays: number;
}
