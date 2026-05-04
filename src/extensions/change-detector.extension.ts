import { Inject } from '@/decorators/inject.decorator';
import { BaseExtension } from '@/extensions/base.extension';
import type { TrackerLine } from '@/lines/tracker.line';
import type { SnapshotsService } from '@/services/snapshots.service';
import type { FileSnapshot } from '@/snapshots/file.snapshot';
import type { EditorExtension } from '@/types';
import { type ChangeSet, type EditorState, Text } from '@codemirror/state';
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

    changes.iterChanges((fromA: number, toA: number, fromB: number, toB: number): void => {
      // Line numbers (0-based) touched by this change in the old and new docs.
      const fromOldLine: number = prev.lineAt(fromA).number - 1;
      const toOldLine: number = prev.lineAt(toA).number - 1;
      const fromNewLine: number = state.doc.lineAt(fromB).number - 1;
      const toNewLine: number = state.doc.lineAt(toB).number - 1;

      // A boundary line survives when the edit keeps part of it: a preserved
      // prefix (edit starts after the line start) or suffix (edit ends before
      // the line end). The preserved span has equal length in both docs, so the
      // new-doc positions decide it for both sides.
      const prefixShared: boolean = fromB > state.doc.lineAt(fromB).from;
      const suffixShared: boolean = toB < state.doc.lineAt(toB).to;

      // The "core" lines are the ones wholly replaced: every old core line is
      // gone and every new core line is brand new.
      const oldCoreStart: number = fromOldLine + (prefixShared ? 1 : 0);
      const oldCoreEnd: number = toOldLine - (suffixShared ? 1 : 0);
      const newCoreStart: number = fromNewLine + (prefixShared ? 1 : 0);
      const newCoreEnd: number = toNewLine - (suffixShared ? 1 : 0);

      const oldCoreCount: number = Math.max(0, oldCoreEnd - oldCoreStart + 1);
      const newCoreCount: number = Math.max(0, newCoreEnd - newCoreStart + 1);

      if (oldCoreCount === newCoreCount && oldCoreCount > 0) {
        // Same number of lines in and out: each core line was edited in place.
        for (let i: number = 0; i < newCoreCount; i++) {
          const tracker: TrackerLine | null = snapshot.findCurrentLine(newCoreStart + i);

          tracker?.change(currentLines[newCoreStart + i]);
        }
      } else {
        // Counts differ: treat the block as delete + insert so destroyed
        // originals are removed and the replacements are added (no mismapping).
        // Capture the doomed originals first, insert the new lines, then remove
        // the originals by reference. Removing only after the inserts means the
        // originals are not yet in a removed state, so a same-transaction insert
        // adds a fresh line instead of resurrecting them.
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

      // Update the content of the surviving boundary lines. The suffix line is
      // read after add/remove shifts, so it sits at its final new position.
      if (prefixShared) {
        snapshot.findCurrentLine(fromNewLine)?.change(currentLines[fromNewLine]);
      }

      if (suffixShared && toNewLine !== fromNewLine) {
        snapshot.findCurrentLine(toNewLine)?.change(currentLines[toNewLine]);
      }
    }, true);

    snapshot.updateState(currentLines);
    snapshot.updateChanges();
  }
}
