import { Inject } from '@/decorators/inject.decorator';
import { BaseExtension } from '@/extensions/base.extension';
import type { TrackerLine } from '@/lines/tracker.line';
import type { SnapshotsService } from '@/services/snapshots.service';
import type { FileSnapshot } from '@/snapshots/file.snapshot';
import type { EditorExtension } from '@/types';
import { type ChangeSet, type EditorState, Text, type TextIterator } from '@codemirror/state';
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
    const currentContent: string = this.view?.state.doc.toString();
    const snapshot: FileSnapshot = this.snapshotsService.getOne();

    if (!snapshot || !currentContent) {
      return;
    }

    // If the content has not changed (by hash), skip
    if (!snapshot.isNeedUpdate(currentContent)) {
      return;
    }

    this.computeIncrementalChanges(update.changes);
    this.snapshotsService.forceUpdate();
  }

  /**
   * Computes incremental changes in the document based on the ChangeSet.
   * Tracks line additions, modifications, and removals to maintain change history.
   * Updates the file snapshot with the new state after processing all changes.
   *
   * @param {ChangeSet} changes - The ChangeSet from CodeMirror containing all document changes
   * @return {void}
   */
  public computeIncrementalChanges(changes: ChangeSet): void {
    const state: EditorState = this.view?.state;
    const currentLines: string[] = state.doc.toString().split(state.lineBreak) || [];
    const snapshot: FileSnapshot = this.snapshotsService.getOne();
    const prev: Text = Text.of(snapshot.getLastStateLines() || currentLines);

    // eslint-disable-next-line max-params
    changes.iterChanges((fromA: number, toA: number, fromB: number, toB: number, inserted: Text): void => {
      const fromNewLine: number = state.doc.lineAt(fromB).number - 1;
      const toNewLine: number = state.doc.lineAt(toB).number - 1;

      const fromOldLine: number = prev.lineAt(fromA).number - 1;
      const toOldLine: number = prev.lineAt(toA).number - 1;

      const start: number = Math.min(fromNewLine, toNewLine);
      const line: TextIterator = inserted.iterLines();
      let offset: number = 0;
      const linesDiffCount: number = ((fromOldLine - toOldLine) + (toNewLine - fromNewLine)); //  + inserted.lines;

      // removed
      if (linesDiffCount < 0) {
        for (let i = 0; i <= Math.abs(linesDiffCount) - 1; i++) {
          const index = toOldLine - i;

          snapshot.removeTrackerOrLine(index);
        }
      }

      // added
      if (linesDiffCount > 0) {
        for (let i: number = 1; i <= Math.abs(linesDiffCount); i++) {
          const index: number = fromNewLine + i;

          snapshot.restoreOrAddTracker(index);
        }
      }

      do {
        const lineNumber: number = offset + start;
        const tracker: TrackerLine = snapshot.findCurrentLine(lineNumber);

        if (offset >= inserted.lines) {
          continue;
        }

        tracker?.change(currentLines[lineNumber]);

        offset++;
      } while (!line.next().done);
    }, true);

    snapshot.updateState(currentLines);
    snapshot.updateChanges();
  }
}
