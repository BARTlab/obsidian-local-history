import type LineChangeTrackerPlugin from '@/main';
import type { FileSnapshot } from '@/snapshots/file.snapshot';
import type { DiffRenderMode } from '@/types';

/**
 * Host port the {@link FolderDiffRenderer} reads its shared modal state through.
 * The renderer owns the diff pane (the diff body, the above-diff notice, and the
 * side-by-side column header) but stays stateless about the modal: it reads the
 * live containers, the selected display mode, the selected timeline point T, the
 * tree's selected file, and the snapshot map back through this port. After every
 * render it calls {@link onDiffRendered} so the host can re-sync concerns it
 * still owns (the toolbar action-button states), keeping the diff renderer free
 * of any toolbar coupling.
 */
export interface FolderDiffHost {
  /** The plugin instance, used only for translation lookups. */
  readonly plugin: LineChangeTrackerPlugin;

  /**
   * The diff body container, or `undefined` before the shell is built. The
   * renderer is a no-op when it is absent.
   *
   * @return {HTMLElement | undefined} The diff container, or undefined
   */
  diffContainerEl(): HTMLElement | undefined;

  /**
   * The above-diff notice container, or `undefined` before the shell is built.
   *
   * @return {HTMLElement | undefined} The notice container, or undefined
   */
  noticeEl(): HTMLElement | undefined;

  /**
   * The side-by-side column header container, or `undefined` before the shell
   * is built.
   *
   * @return {HTMLElement | undefined} The columns header container, or undefined
   */
  columnsHeaderEl(): HTMLElement | undefined;

  /**
   * The currently selected display mode, used to choose the diff layout and to
   * decide whether the side-by-side column header is shown.
   *
   * @return {DiffRenderMode} The selected display mode
   */
  displayMode(): DiffRenderMode;

  /**
   * The currently selected timeline point T in ms: the diff base, the notice,
   * and the left column header all read against it.
   *
   * @return {number} The selected T
   */
  selectedTimestamp(): number;

  /**
   * The vault-relative path of the file currently focused in the tree, or
   * `null` when nothing is selected.
   *
   * @return {string | null} The selected file path, or null
   */
  selectedPath(): string | null;

  /**
   * The snapshot map keyed by path, used to resolve the selected file back to
   * its snapshot for the per-file delta at T.
   *
   * @return {Map<string, FileSnapshot>} The snapshot map
   */
  snapshotsByPath(): Map<string, FileSnapshot>;

  /**
   * Called after every diff render so the host can re-sync concerns it still
   * owns (the toolbar action-button states), keeping that toolbar logic off the
   * diff renderer.
   */
  onDiffRendered(): void;
}
