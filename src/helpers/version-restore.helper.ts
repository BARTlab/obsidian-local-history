import type { SnapshotsService } from '@/services/snapshots.service';
import type { TFile } from 'obsidian';

/**
 * Inputs for {@link restoreWholeVersion}: the snapshot service that performs the
 * write plus the live state a whole-file restore needs.
 */
export interface WholeVersionRestoreRequest {
  /** Applies the reverted content and refreshes the highlights. */
  snapshotsService: SnapshotsService;

  /** The file the restore writes into. */
  file: TFile;

  /** The base content to write back, as lines. */
  baseLines: string[];

  /** The current content as lines, the span the whole-file block replaces. */
  currentLines: string[];

  /** The line break used for the base/current equality no-op guard. */
  lineBreak: string;
}

/**
 * Rewrites the whole file to a base version: the choreography shared by the file
 * modal's restore, the folder modal's synthetic-baseline restore, and the
 * version-actions service. Short-circuits when the base already equals the
 * current content (the no-op guard), otherwise writes the base back through the
 * snapshot service scoped to the entire file. Distinct from the single-hunk
 * revert: the block spans every current line (removeCount is currentLines.length)
 * rather than one hunk. Returns whether the write happened so a caller can report
 * the outcome.
 *
 * @param {WholeVersionRestoreRequest} request - The service, live state, and base
 * @return {Promise<boolean>} True when the content differed and was written
 */
export async function restoreWholeVersion(request: WholeVersionRestoreRequest): Promise<boolean> {
  const { snapshotsService, file, baseLines, currentLines, lineBreak } = request;

  if (baseLines.join(lineBreak) === currentLines.join(lineBreak)) {
    return false;
  }

  await snapshotsService.applyContent(file, baseLines, {
    start: 0,
    removeCount: currentLines.length,
    newLines: baseLines,
  });

  return true;
}
