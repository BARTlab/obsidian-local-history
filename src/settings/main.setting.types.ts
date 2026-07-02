/**
 * The four stored-history retention caps rendered in the cleanup group, keyed
 * by their `retention.*` settings path segment.
 */
export type RetentionKey = 'maxEntries' | 'maxAgeDays' | 'maxDeletedEntries' | 'maxDeletedAgeDays';
