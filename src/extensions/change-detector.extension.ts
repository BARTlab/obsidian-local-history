import { Inject } from '@/decorators/inject.decorator';
import { BaseExtension } from '@/extensions/base.extension';
import type { TrackerLine } from '@/lines/tracker.line';
import type { SettingsService } from '@/services/settings.service';
import type { SnapshotsService } from '@/services/snapshots.service';
import type { FileSnapshot } from '@/snapshots/file.snapshot';
import type { EditorExtension, SnapshotCaptureOptions } from '@/types';
import { type EditorState, type Text } from '@codemirror/state';
import { Decoration, type DecorationSet, type ViewUpdate } from '@codemirror/view';

/**
 * Extension that detects changes in the editor and updates file snapshots.
 * Tracks line additions, modifications, and removals to maintain change history.
 *
 * @implements {EditorExtension}
 * @extends {BaseExtension}
 */
export class ChangeDetectorExtension extends BaseExtension implements EditorExtension {
  /**
   * Service for managing file snapshots.
   * Injected using the @Inject decorator.
   */
  @Inject('SnapshotsService')
  protected snapshotsService: SnapshotsService;

  /**
   * Service for reading the intermediate-snapshot cadence settings.
   * Injected using the @Inject decorator.
   */
  @Inject('SettingsService')
  protected settingsService: SettingsService;

  /**
   * Set of decorations to be applied to the editor.
   * Initialized with an empty decoration set.
   */
  public decorations: DecorationSet = Decoration.none;

  /**
   * Handles updates to the editor view.
   * Processes document changes to track line modifications.
   *
   * @param {ViewUpdate} update - The view update event from CodeMirror
   */
  public update(update: ViewUpdate): void {
    if (!update.docChanged) {
      return;
    }

    this.processIncrementalChanges(update);
  }

  /**
   * Processes incremental changes in the document.
   * Checks if the content has changed and computes the changes if needed.
   *
   * @param {ViewUpdate} update - The view update event from CodeMirror
   */
  protected processIncrementalChanges(update: ViewUpdate): void {
    const currentContent: string = update.state.doc.toString();
    const snapshot: FileSnapshot = this.snapshotsService.getOne();

    if (!snapshot || !currentContent) {
      return;
    }

    /**
     * Skip when the content has not changed, detected by the snapshot hash.
     */
    if (!snapshot.isNeedUpdate(currentContent)) {
      return;
    }

    this.computeIncrementalChanges(update);
    this.snapshotsService.forceUpdate();
  }

  /**
   * Computes incremental changes in the document based on the ViewUpdate.
   * Tracks line additions, modifications, and removals to maintain change history.
   * Updates the file snapshot with the new state after processing all changes.
   *
   * The old-document side of the ChangeSet (fromA/toA) is mapped against
   * update.startState, which is by construction the editor state those positions
   * index into. Deriving the previous text from the update (not the snapshot's
   * cached state) keeps line mapping correct even when an earlier update was
   * skipped by the hash guard and left the cached state stale.
   *
   * @param {ViewUpdate} update - The view update event from CodeMirror
   * @return {void}
   */
  public computeIncrementalChanges(update: ViewUpdate): void {
    const state: EditorState = update.state;
    /**
     * Split on `/\r?\n/` (ADR-08-G) so a CRLF document does not leave a
     * trailing `\r` on every tracked line; `state.lineBreak` is a single
     * convention string that misses mixed or unexpected line endings.
     */
    const currentLines: string[] = state.doc.toString().split(/\r?\n/);
    const snapshot: FileSnapshot = this.snapshotsService.getOne();
    const prev: Text = update.startState.doc;

    update.changes.iterChanges((fromA: number, toA: number, fromB: number, toB: number): void => {
      /**
       * Line numbers (0-based) touched by this change in the old and new docs.
       */
      const fromOldLine: number = prev.lineAt(fromA).number - 1;
      const toOldLine: number = prev.lineAt(toA).number - 1;
      const fromNewLine: number = state.doc.lineAt(fromB).number - 1;
      const toNewLine: number = state.doc.lineAt(toB).number - 1;

      /**
       * A boundary line survives when the edit keeps part of it: a preserved
       * prefix (edit starts after the line start) or suffix (edit ends before
       * the line end). The preserved span has equal length in both docs, so the
       * new-doc positions decide it for both sides.
       */
      const prefixShared: boolean = fromB > state.doc.lineAt(fromB).from;
      const suffixShared: boolean = toB < state.doc.lineAt(toB).to;

      /**
       * The "core" lines are the ones wholly replaced: every old core line is
       * gone and every new core line is brand new.
       */
      const oldCoreStart: number = fromOldLine + (prefixShared ? 1 : 0);
      const oldCoreEnd: number = toOldLine - (suffixShared ? 1 : 0);
      const newCoreStart: number = fromNewLine + (prefixShared ? 1 : 0);
      const newCoreEnd: number = toNewLine - (suffixShared ? 1 : 0);

      const oldCoreCount: number = Math.max(0, oldCoreEnd - oldCoreStart + 1);
      const newCoreCount: number = Math.max(0, newCoreEnd - newCoreStart + 1);

      if (oldCoreCount === newCoreCount && oldCoreCount > 0) {
        /**
         * Same number of lines in and out: each core line was edited in place.
         */
        for (let i: number = 0; i < newCoreCount; i++) {
          const tracker: TrackerLine | null = snapshot.findCurrentLine(newCoreStart + i);

          tracker?.change(currentLines[newCoreStart + i]);
        }
      } else {
        /**
         * Counts differ: treat the block as delete + insert so destroyed
         * originals are removed and the replacements are added (no mismapping).
         * Capture the doomed originals first, insert the new lines, then remove
         * the originals by reference. Removing only after the inserts means the
         * originals are not yet in a removed state, so a same-transaction insert
         * adds a fresh line instead of resurrecting them.
         */
        const doomed: TrackerLine[] = [];

        for (let index: number = oldCoreStart; index <= oldCoreEnd; index++) {
          const tracker: TrackerLine | null = snapshot.findCurrentLine(index);

          if (tracker) {
            doomed.push(tracker);
          }
        }

        for (let index: number = newCoreStart; index <= newCoreEnd; index++) {
          const added: TrackerLine = snapshot.restoreOrAddTracker(index);

          added?.change(currentLines[index]);
        }

        doomed.forEach((tracker: TrackerLine): void => {
          snapshot.removeTrackerOrLine(tracker);
        });
      }

      /**
       * Update the content of the surviving boundary lines. The suffix line is
       * read after add/remove shifts, so it sits at its final new position.
       */
      if (prefixShared) {
        snapshot.findCurrentLine(fromNewLine)?.change(currentLines[fromNewLine]);
      }

      if (suffixShared && toNewLine !== fromNewLine) {
        snapshot.findCurrentLine(toNewLine)?.change(currentLines[toNewLine]);
      }
    }, true);

    /**
     * Freeze the pre-edit state on the timeline before recording the new state,
     * so a captured version preserves the earlier point. Cadence gating lives
     * in the snapshot, so this stays cheap on the keystroke path.
     */
    snapshot.captureVersion(snapshot.getLastStateLines(), this.getCaptureOptions());

    snapshot.updateState(currentLines);
    snapshot.updateChanges();
  }

  /**
   * Reads the current intermediate-snapshot cadence settings into a plain
   * options object for the snapshot model.
   *
   * @return {SnapshotCaptureOptions} The capture cadence configuration
   */
  protected getCaptureOptions(): SnapshotCaptureOptions {
    return {
      enabled: this.settingsService.value('snapshots.enabled'),
      intervalMs: this.settingsService.value('snapshots.intervalMs'),
      editThreshold: this.settingsService.value('snapshots.editThreshold'),
      maxVersions: this.settingsService.value('snapshots.maxVersions'),
      maxVersionAgeDays: this.settingsService.value('snapshots.maxVersionAgeDays'),
    };
  }
}
