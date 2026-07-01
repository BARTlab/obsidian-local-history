import type LineChangeTrackerPlugin from '@/main';
import type { FileSnapshot } from '@/snapshots/file.snapshot';
import type { FolderTimelinePoint } from '@/types';

/**
 * Host port the {@link FolderTimelineRenderer} reads its shared modal state
 * through. The renderer owns the rail rendering but stays stateless about the
 * modal: it reads the live timeline, the selected timeline point T, the rail
 * container, and the snapshot map back through this port, and reports a new T
 * via {@link selectTimestamp} so the host re-pins it and re-renders the tree
 * and diff.
 */
export interface FolderTimelineHost {
  /** The plugin instance, used only for translation lookups. */
  readonly plugin: LineChangeTrackerPlugin;

  /**
   * Left rail container the timeline renders into, or `undefined` before the
   * shell is built. The renderer is a no-op when it is absent.
   *
   * @return {HTMLElement | undefined} The rail container, or undefined
   */
  railEl(): HTMLElement | undefined;

  /**
   * The timeline points to render, newest-first, grouped by day key.
   *
   * @return {FolderTimelinePoint[]} The timeline points
   */
  timeline(): FolderTimelinePoint[];

  /**
   * The currently selected timeline point T in ms, used to mark the active row.
   *
   * @return {number} The selected T
   */
  selectedTimestamp(): number;

  /**
   * The snapshot map keyed by path, used to resolve a capture point back to its
   * version when deciding whether the row carries an external badge.
   *
   * @return {Map<string, FileSnapshot>} The snapshot map
   */
  snapshotsByPath(): Map<string, FileSnapshot>;

  /**
   * Pins a new timeline point T. The host updates its selected T, re-renders the
   * rail, re-colours the tree, and refreshes the diff. A no-op on the host side
   * when T is already selected.
   *
   * @param {number} timestamp - The new selected T
   */
  selectTimestamp(timestamp: number): void;
}
