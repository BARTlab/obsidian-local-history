import type LineChangeTrackerPlugin from '@/main';
import type { ModalsService } from '@/services/modals.service';
import type { SnapshotsService } from '@/services/snapshots.service';
import type { FileSnapshot } from '@/snapshots/file.snapshot';
import type { DiffRenderMode } from '@/types';
import type * as Diff from 'diff';

/**
 * Host port the {@link GutterRevertHandler} reads its shared modal state
 * through. The handler owns the revert affordances and the hunk anchoring but
 * stays stateless about the modal: it reads the live diff container, the active
 * display mode, and the current hunks back through this port, drives the revert
 * through the snapshot services, and reports a completed revert and the
 * post-decoration nav refresh back to the host.
 */
export interface GutterRevertHost {
  /** The file snapshot whose live state the reverts write into. */
  readonly snapshot: FileSnapshot;

  /** The plugin instance, used for translation lookups and the confirm copy. */
  readonly plugin: LineChangeTrackerPlugin;

  /** Service that runs the confirm dialog before a destructive revert. */
  readonly modalsService: ModalsService;

  /** Service that applies the reverted content and refreshes the highlights. */
  readonly snapshotsService: SnapshotsService;

  /**
   * The rendered diff container, or `undefined` before the first render. The
   * handler is a no-op when it is absent.
   *
   * @return {HTMLElement | undefined} The diff container, or undefined
   */
  diffContainer(): HTMLElement | undefined;

  /**
   * The active diff display mode, used to choose the anchor-resolution strategy
   * (inline rows vs diff2html rows, line-by-line vs side-by-side).
   *
   * @return {DiffRenderMode} The current display mode
   */
  displayMode(): DiffRenderMode;

  /**
   * The line-level hunks between the selected base and the live state, in
   * document order. Recomputed on demand so the offsets reflect live content.
   *
   * @return {Diff.StructuredPatchHunk[]} The hunks, top to bottom
   */
  getHunks(): Diff.StructuredPatchHunk[];

  /**
   * Refreshes the next/previous difference button state after the handler has
   * decorated the rows with their anchors (the hunk set is now known).
   */
  updateNavButtonsState(): void;

  /**
   * Reports a completed revert so the host can drop the stale hunk focus and
   * re-render the active diff against the new content.
   */
  onReverted(): void;
}
