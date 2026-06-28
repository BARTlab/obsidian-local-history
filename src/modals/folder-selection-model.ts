import { FolderDeltaHelper } from '@/helpers/folder-delta.helper';
import { FolderTimelineHelper } from '@/helpers/folder-timeline.helper';
import type { FolderActionSelection } from '@/modals/folder-action-handler';
import type { FileSnapshot } from '@/snapshots/file.snapshot';
import type { FileVersion } from '@/snapshots/file.version';
import type { FolderTimelinePoint } from '@/types';

/**
 * Pure timeline / selection model for the folder-history modal.
 *
 * Extracted from {@link FolderHistoryModal} as a DOM-free, unit-testable object
 * the modal instantiates and owns. It holds the synthesised timeline and the
 * selected point T, and answers the three questions the modal and its action
 * handler ask about them: which captured version of a snapshot is closest to T,
 * which tree-selected file resolves to an actionable selection at T, and how the
 * timeline / selected T re-settle after a destructive action changed the map.
 * The snapshot map, the tree's selected path, and the folder root are passed in
 * as arguments so the model never touches the modal's DOM or its collaborators.
 */
export class FolderSelectionModel {
  /**
   * Timeline points synthesised from the snapshot map, newest-first. Rebuilt by
   * {@link resync} when a destructive action changes the map.
   */
  protected timelinePoints: FolderTimelinePoint[];

  /**
   * Currently selected timeline point T, in ms. Defaults to the newest point's
   * timestamp; falls back to {@link Date.now} when the timeline is empty (a
   * defensive value, since the folder modal is never opened with no snapshots).
   */
  protected selectedT: number;

  /**
   * @param {FileSnapshot[]} snapshots - The snapshots under the folder root
   * @param {string} rootPath - The vault-relative folder path
   */
  public constructor(snapshots: FileSnapshot[], rootPath: string) {
    this.timelinePoints = FolderTimelineHelper.synthesize(snapshots, rootPath);
    this.selectedT = this.timelinePoints.length > 0 ? this.timelinePoints[0].timestamp : Date.now();
  }

  /**
   * The synthesised timeline points, newest-first.
   *
   * @return {FolderTimelinePoint[]} The timeline points
   */
  public get timeline(): FolderTimelinePoint[] {
    return this.timelinePoints;
  }

  /**
   * The currently selected timeline point T, in ms.
   *
   * @return {number} The selected T
   */
  public get selectedTimestamp(): number {
    return this.selectedT;
  }

  /**
   * Pins a new selected timeline point T. The caller decides whether to re-render
   * after the change; this only moves the model's selection.
   *
   * @param {number} timestamp - The new selected T
   */
  public select(timestamp: number): void {
    this.selectedT = timestamp;
  }

  /**
   * Resolves the captured version of the given snapshot whose timestamp is
   * closest to (but not after) the selected T. Returns null when no version
   * qualifies, i.e. when T precedes every captured version: the caller falls back
   * to the synthetic baseline branch in that case so the user can still restore
   * the file's earliest known content.
   *
   * @param {FileSnapshot} snapshot - The file's snapshot
   * @return {FileVersion | null} The closest version at/before T, or null
   */
  public resolveVersionAtT(snapshot: FileSnapshot): FileVersion | null {
    const versions: FileVersion[] = snapshot.getVersions();
    let candidate: FileVersion | null = null;

    versions.forEach((version: FileVersion): void => {
      if (version.timestamp > this.selectedT) {
        return;
      }

      if (!candidate || version.timestamp > candidate.timestamp) {
        candidate = version;
      }
    });

    return candidate;
  }

  /**
   * Resolves the tree-selected file back to its snapshot and the per-file delta at
   * T in a single shot, so each handler can early-exit on an empty selection
   * without re-computing the same lookup. The selected path (owned by the tree
   * component) and the snapshot map (owned by the modal) are passed in, keeping
   * the model DOM-free.
   *
   * @param {string | null} selectedPath - The tree's selected file path, or null
   * @param {Map<string, FileSnapshot>} snapshotsByPath - The snapshot map keyed by path
   * @return {FolderActionSelection | null} The resolved selection, or null
   */
  public resolveSelection(
    selectedPath: string | null,
    snapshotsByPath: Map<string, FileSnapshot>,
  ): FolderActionSelection | null {
    if (!selectedPath) {
      return null;
    }

    const snapshot: FileSnapshot | undefined = snapshotsByPath.get(selectedPath);

    if (!snapshot) {
      return null;
    }

    return {
      path: selectedPath,
      snapshot,
      result: FolderDeltaHelper.compareAt(snapshot, this.selectedT),
    };
  }

  /**
   * Re-synthesises the timeline from the live snapshot map and clamps the selected
   * T to the nearest remaining point (defaults to the newest one when the original
   * point is gone). Used after a destructive action that removed a version or wiped
   * a file's history so the rail does not surface stale entries. Leaves T untouched
   * when the subtree is now empty; the caller re-renders the empty-state rail.
   *
   * @param {Map<string, FileSnapshot>} snapshotsByPath - The live snapshot map
   * @param {string} rootPath - The vault-relative folder path
   */
  public resync(snapshotsByPath: Map<string, FileSnapshot>, rootPath: string): void {
    this.timelinePoints = FolderTimelineHelper.synthesize(
      Array.from(snapshotsByPath.values()),
      rootPath,
    );

    if (this.timelinePoints.length === 0) {
      return;
    }

    const stillExists: boolean = this.timelinePoints.some(
      (point: FolderTimelinePoint): boolean => point.timestamp === this.selectedT,
    );

    if (!stillExists) {
      this.selectedT = this.timelinePoints[0].timestamp;
    }
  }
}
