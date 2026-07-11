/**
 * The four stored-history retention caps rendered in the cleanup group, keyed
 * by their `retention.*` settings path segment.
 */
export type RetentionKey = 'maxEntries' | 'maxAgeDays' | 'maxDeletedEntries' | 'maxDeletedAgeDays';

/**
 * Structural slice of `ButtonComponent` for feature-detecting the destructive
 * style API (Obsidian 1.13+) without referencing the typed member, which the
 * `obsidianmd/no-unsupported-api` gate forbids while `minAppVersion` is lower.
 */
export interface DestructiveCapableButton {
  setDestructive?(): unknown;
}
