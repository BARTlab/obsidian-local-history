import { HunkHelper } from '@/helpers/hunk.helper';
import type { ModalsService } from '@/services/modals.service';
import type { SnapshotsService } from '@/services/snapshots.service';
import type * as Diff from 'diff';
import type { TFile } from 'obsidian';

/**
 * Inputs for {@link confirmAndRevertHunk}: the services and live state a single
 * revert needs, plus the resolved hunk to write back to the base.
 */
export interface HunkRevertRequest {
  /**
   * Runs the confirm dialog before the destructive write.
   */
  modalsService: ModalsService;

  /**
   * Applies the reverted content and refreshes the highlights.
   */
  snapshotsService: SnapshotsService;

  /**
   * Translation lookup for the confirm copy.
   */
  plugin: { t(key: string): string };

  /**
   * The file the revert writes into.
   */
  file: TFile;

  /**
   * The current content as lines, the base for the positional splice.
   */
  currentLines: string[];

  /**
   * The resolved hunk to revert.
   */
  hunk: Diff.StructuredPatchHunk;

  /**
   * Cancel button label. Omit to keep the confirm modal's built-in default,
   * which the dot gutter relies on; the other call sites pass their own.
   */
  cancelText?: string;
}

/**
 * Confirms then reverts a single hunk back to the base: the one choreography
 * shared by the dot gutter, the removed gutter, and the history modal. Prompts
 * with the shared revert copy and, on accept, writes the hunk-reverted content
 * through the snapshot service scoped to exactly that block. Returns whether the
 * revert was applied so a caller can react (the modal re-renders its diff).
 *
 * @param {HunkRevertRequest} request - The services, live state, and target hunk
 * @return {Promise<boolean>} True when the revert was confirmed and applied
 */
export async function confirmAndRevertHunk(request: HunkRevertRequest): Promise<boolean> {
  const confirmed: boolean = await request.modalsService.confirm({
    title: request.plugin.t('modal.confirm.revert.title'),
    message: request.plugin.t('modal.confirm.revert.message'),
    confirmText: request.plugin.t('modal.confirm.revert.button'),
    cancelText: request.cancelText,
  });

  if (!confirmed) {
    return false;
  }

  await request.snapshotsService.applyContent(
    request.file,
    HunkHelper.revertHunk(request.currentLines, request.hunk),
    HunkHelper.revertDescriptor(request.currentLines, request.hunk),
  );

  return true;
}
