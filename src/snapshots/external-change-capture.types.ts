import type LineChangeTrackerPlugin from '@/main';
import type { FileSnapshot } from '@/snapshots/file.snapshot';
import type { SnapshotCaptureOptions } from '@/types';
import type { TFile } from 'obsidian';

/**
 * Host port the {@link ExternalChangeCapture} reads its shared snapshot state
 * through. The collaborator owns the debounce/in-flight/last-seen machinery and
 * the off-editor capture flow but stays stateless about the snapshot map: it
 * looks up a path's snapshot, asks the host whether a path is capturable, and
 * routes a first-sight capture and the post-capture forced update back through
 * the host so the {@link SnapshotsService} keeps sole ownership of the snapshot
 * CRUD.
 */
export interface ExternalChangeHost {
  /** The plugin instance, used for the disk read of the modified file. */
  readonly plugin: LineChangeTrackerPlugin;

  /**
   * The snapshot currently keyed by `path`, or `undefined` when the path has
   * never been captured this session (a first-sight file).
   *
   * @param {string} path - The vault-relative path to look up
   * @return {FileSnapshot | undefined} The snapshot, or undefined
   */
  getSnapshot(path: string): FileSnapshot | undefined;

  /**
   * Whether the file is eligible for external capture: an allowed extension, a
   * non-excluded path, and not on the ignore list. Mirrors the parts of
   * `canCapture` that still apply when a snapshot already exists.
   *
   * @param {TFile} file - The file whose external modify event fired
   * @return {boolean} True when the file may be externally captured
   */
  isExternallyCapturable(file: TFile): boolean;

  /**
   * Captures a first-sight file as a normal snapshot (no external version).
   * Delegated to the host so snapshot creation stays owned by the service.
   *
   * @param {TFile} file - The file to capture for the first time
   * @return {Promise<void>} Resolves once the first-sight capture completes
   */
  captureFirstSight(file: TFile): Promise<void>;

  /**
   * The current capture cadence/retention options, used when force-capturing
   * the external version so eviction stays aligned with every capture source.
   *
   * @return {SnapshotCaptureOptions} The capture cadence configuration
   */
  getCaptureOptions(): SnapshotCaptureOptions;

  /**
   * Notifies the observable snapshot map that a capture mutated a snapshot so
   * subscribers (the editor, the tree/tab decorator) refresh.
   */
  forceUpdate(): void;
}
