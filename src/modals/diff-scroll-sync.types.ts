import type { HTMLElementWithScrollSync } from '@/types';

/**
 * Resolves the diff container the host is currently rendering into, or
 * `undefined` before any diff has been mounted. The deferred setup re-reads it
 * to bail when the container was swapped (rapid mode switch) before the timer
 * fired, so no listeners attach to stale DOM.
 */
export type DiffContainerResolver = () => HTMLElementWithScrollSync | undefined;
