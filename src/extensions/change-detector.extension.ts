import { Inject } from '@/decorators/inject.decorator';
import type { TrackerLine } from '@/lines/tracker.line';
import type LineChangeTrackerPlugin from '@/main';
import type { SettingsService } from '@/services/settings.service';
import type { SnapshotsService } from '@/services/snapshots.service';
import { TOKENS } from '@/services/tokens';
import type { FileSnapshot } from '@/snapshots/file.snapshot';
import type { EditorExtension, SnapshotCaptureOptions } from '@/types';
import { type EditorState, type Text } from '@codemirror/state';
import { Decoration, type DecorationSet, type EditorView, type ViewUpdate } from '@codemirror/view';

/**
 * Extension that detects changes in the editor and updates file snapshots.
 * Tracks line additions, modifications, and removals to maintain change history.
 *
 * @implements {EditorExtension}
 */
export class ChangeDetectorExtension implements EditorExtension {
  /**
   * Set of decorations to be applied to the editor.
   * Initialized with an empty decoration set.
   */
  public decorations: DecorationSet = Decoration.none;

  @Inject(TOKENS.snapshots)
  protected snapshotsService!: SnapshotsService;

  /** Service for reading the intermediate-snapshot cadence settings. */
  @Inject(TOKENS.settings)
  protected settingsService!: SettingsService;

  public constructor(
    protected view: EditorView | null,
    public plugin: LineChangeTrackerPlugin,
  ) {
  }

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
     * Split on `/\r?\n/` so a CRLF document does not leave a
     * trailing `\r` on every tracked line; `state.lineBreak` is a single
     * convention string that misses mixed or unexpected line endings.
     */
    const currentLines: string[] = state.doc.toString().split(/\r?\n/);
    const snapshot: FileSnapshot | null = this.snapshotsService.getOne();
    const prev: Text = update.startState.doc;

    if (!snapshot) {
      return;
    }

    update.changes.iterChanges((fromA: number, toA: number, fromB: number, toB: number): void => {
      // Line numbers (0-based) touched by this change in the old and new docs.
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
      let suffixShared: boolean = toB < state.doc.lineAt(toB).to;

      /**
       * Empty-boundary-line rescue. The byte-length check above reads false for
       * an empty boundary line in both docs (`.from === .to`), so a pure
       * insertion at the start of an empty line (commonly the trailing empty
       * line) or a pure deletion that strands the new range at an empty line
       * appears to wipe and re-create that empty line. The downstream model then
       * removes the original anchor and adds a brand-new tracker, leaving a
       * phantom `removed` mark at the boundary and breaking later
       * `findRemovedAt` lookups for that anchor (visible to the user as artefacts
       * after pasting/restoring tables at the document end). Treat the boundary
       * line as preserved when the change creates a new `\n` adjacent to it on
       * the surviving side: insertion ending with `\n` (pure insert) or
       * deletion consuming the trailing `\n` (pure delete). When the insertion
       * carries actual content into the empty line (no trailing `\n`), the
       * in-place edit path is the right behaviour and this rescue is skipped.
       */
      if (!prefixShared && !suffixShared) {
        const isPureInsertEndingInNewline: boolean =
          fromA === toA && toB > 0 && state.doc.sliceString(toB - 1, toB) === '\n';

        const isPureDeleteConsumingNewline: boolean =
          fromB === toB && toA > 0 && prev.sliceString(toA - 1, toA) === '\n';

        suffixShared = isPureInsertEndingInNewline || isPureDeleteConsumingNewline;
      }

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
        // Same number of lines in and out: each core line was edited in place.
        for (let i: number = 0; i < newCoreCount; i++) {
          const tracker: TrackerLine | null = snapshot.trackers.findCurrentLine(newCoreStart + i);

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
          const tracker: TrackerLine | null = snapshot.trackers.findCurrentLine(index);

          if (tracker) {
            doomed.push(tracker);
          }
        }

        for (let index: number = newCoreStart; index <= newCoreEnd; index++) {
          const added: TrackerLine = snapshot.trackers.restoreOrAddTracker(index);

          added?.change(currentLines[index]);
        }

        doomed.forEach((tracker: TrackerLine): void => {
          snapshot.trackers.removeTrackerOrLine(tracker);
        });
      }

      /**
       * Update the content of the surviving boundary lines. The suffix line is
       * read after add/remove shifts, so it sits at its final new position.
       */
      if (prefixShared) {
        snapshot.trackers.findCurrentLine(fromNewLine)?.change(currentLines[fromNewLine]);
      }

      if (suffixShared && toNewLine !== fromNewLine) {
        snapshot.trackers.findCurrentLine(toNewLine)?.change(currentLines[toNewLine]);
      }
    }, true);

    /**
     * Self-heal pass: re-sync every tracker's `current` with the actual line
     * content at its currentPosition. The incremental diff above is supposed to
     * keep them aligned, but edge cases observed in the wild (compound
     * transactions where Obsidian's table editor dispatches a row-replacement
     * alongside other edits; a stale `prev` line layout after a hash-collision
     * skip; restoreOrAddTracker resurrecting a stale anchor at a far-away
     * position) can leave a tracker whose `current` no longer matches the doc
     * line it points at. That drift surfaces as a `changed` marker on a line
     * the user did not touch (e.g. line 0 lit up while editing a table at the
     * end of the doc). Re-calling `change()` with the real content is cheap
     * (it bails on a hash match without touching state) and converges every
     * tracker back onto the live line, so a stale anchor self-clears on the
     * next edit instead of persisting until the user resets the baseline.
     */
    for (const tracker of snapshot.trackers.getTrackerLines()) {
      if (!tracker.existedInCurrent) {
        continue;
      }

      const actual: string | undefined = currentLines[tracker.currentPosition];

      if (actual !== undefined && tracker.current !== actual) {
        tracker.change(actual);
      }
    }

    /**
     * Freeze the pre-edit state on the timeline before recording the new state,
     * so a captured version preserves the earlier point. Cadence gating lives
     * in the snapshot, so this stays cheap on the keystroke path.
     */
    snapshot.captureVersion(snapshot.content.getLastStateLines(), this.getCaptureOptions());

    snapshot.content.updateState(currentLines);
    snapshot.updateChanges();
  }

  /**
   * Processes incremental changes in the document.
   * Checks if the content has changed and computes the changes if needed.
   *
   * @param {ViewUpdate} update - The view update event from CodeMirror
   */
  protected processIncrementalChanges(update: ViewUpdate): void {
    const currentContent: string = update.state.doc.toString();
    const snapshot: FileSnapshot | null = this.snapshotsService.getOne();

    if (!snapshot || !currentContent) {
      return;
    }

    // Skip when the content has not changed, detected by the snapshot hash.
    if (!snapshot.isNeedUpdate(currentContent)) {
      return;
    }

    this.computeIncrementalChanges(update);
    this.snapshotsService.forceUpdate();
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
