import { ChangeType } from '@/consts';
import { TextHelper } from '@/helpers/text.helper';
import { ChangeLine } from '@/lines/change.line';
import type { TrackerLine } from '@/lines/tracker.line';
import { ArrayMap } from '@/maps/array.map';
import type { FileVersion } from '@/snapshots/file.version';
import type { AdoptHistoryResult, UpdateStateResult } from '@/types';
import { isArray, isNumber } from 'lodash-es';

/**
 * Stateless operator owning the content/baselines/changes concern extracted from
 * FileSnapshot: the current state and its hash, the marker and history baselines,
 * the no-op/original-state queries, and the change-map recompute from the ordered
 * tracker. It does NOT hold the `state`/`lines`/`historyLines`/`changes`/`lastHash`
 * fields (those stay writable façade properties external code assigns and
 * mutates); every operation takes the façade's data as explicit arguments and
 * returns the result the façade writes back. The tracker is passed in by the
 * façade (sourced from TrackerEditor's getTracker): this collaborator neither
 * owns nor invalidates the tracker.
 */
export class SnapshotState {
  /**
   * Normalizes new content into a state line array and computes its hash. The
   * façade assigns the returned `state` and `lastHash` back to its own fields.
   *
   * @param {string | string[]} content - The new content, as a string or lines
   * @param {string} lineBreak - The line break used to split and join content
   * @return {UpdateStateResult} The normalized state lines and their hash
   */
  public static updateState(content: string | string[], lineBreak: string): UpdateStateResult {
    const state: string[] = isArray(content) ? [...content] : content.split(lineBreak);

    return {
      state,
      lastHash: TextHelper.hash(state.join(lineBreak)),
    };
  }

  /**
   * Whether the current state equals the marker baseline (the session origin the
   * gutter markers measure against).
   *
   * @param {string[]} lines - The marker baseline lines
   * @param {string[]} state - The current state lines
   * @param {string} lineBreak - The line break used to join for comparison
   * @return {boolean} True when the current state matches the marker baseline
   */
  public static isStateSameOriginal(lines: string[], state: string[], lineBreak: string): boolean {
    return this.getOriginalState(lines, lineBreak) === this.getLastState(state, lineBreak);
  }

  /**
   * Joins the current state lines into a string.
   *
   * @param {string[]} state - The current state lines
   * @param {string} lineBreak - The line break used to join the lines
   * @return {string} The current state as a string
   */
  public static getLastState(state: string[], lineBreak: string): string {
    return state.join(lineBreak);
  }

  /**
   * Returns a copy of the current state lines so callers cannot mutate the field.
   *
   * @param {string[]} state - The current state lines
   * @return {string[]} A copy of the current state lines
   */
  public static getLastStateLines(state: string[]): string[] {
    return [...state];
  }

  /**
   * Joins the marker baseline lines (the session origin the gutter markers
   * measure against) into a string.
   *
   * @param {string[]} lines - The marker baseline lines
   * @param {string} lineBreak - The line break used to join the lines
   * @return {string} The marker baseline as a string
   */
  public static getOriginalState(lines: string[], lineBreak: string): string {
    return [...lines].join(lineBreak);
  }

  /**
   * Returns a copy of the marker baseline lines so callers cannot mutate the field.
   *
   * @param {string[]} lines - The marker baseline lines
   * @return {string[]} A copy of the marker baseline lines
   */
  public static getOriginalStateLines(lines: string[]): string[] {
    return [...lines];
  }

  /**
   * Joins the history baseline lines (the persisted original the history modal
   * diffs against) into a string.
   *
   * @param {string[]} historyLines - The history baseline lines
   * @param {string} lineBreak - The line break used to join the lines
   * @return {string} The history baseline as a string
   */
  public static getHistoryOriginalState(historyLines: string[], lineBreak: string): string {
    return [...historyLines].join(lineBreak);
  }

  /**
   * Returns a copy of the history baseline lines so callers cannot mutate the field.
   *
   * @param {string[]} historyLines - The history baseline lines
   * @return {string[]} A copy of the history baseline lines
   */
  public static getHistoryOriginalStateLines(historyLines: string[]): string[] {
    return [...historyLines];
  }

  /**
   * Normalizes a persisted history baseline and version timeline into defensive
   * copies for the façade to adopt without touching the marker baseline, the
   * tracker, or the current state. Non-array inputs collapse to empty arrays,
   * matching the original guard.
   *
   * @param {string[]} historyLines - The persisted original (history baseline)
   * @param {FileVersion[]} versions - The persisted version timeline, oldest first
   * @return {AdoptHistoryResult} The normalized history baseline and timeline
   */
  public static adoptHistory(historyLines: string[], versions: FileVersion[]): AdoptHistoryResult {
    return {
      historyLines: isArray(historyLines) ? [...historyLines] : [],
      versions: isArray(versions) ? [...versions] : [],
    };
  }

  /**
   * Returns the change map, optionally filtered to the given change types. The
   * façade owns the `changes` field; when a type filter is given a fresh filtered
   * ArrayMap is returned, otherwise the live map is returned for direct use.
   *
   * @param {ArrayMap<ChangeLine>} changes - The façade-owned change map
   * @param {ChangeType | ChangeType[]} type - Optional change types to filter by
   * @return {ArrayMap<ChangeLine>} The change map, filtered when a type is given
   */
  public static getChanges(changes: ArrayMap<ChangeLine>, type?: ChangeType | ChangeType[]): ArrayMap<ChangeLine> {
    if (type) {
      return ArrayMap.make(
        changes
          .filter((change: ChangeLine): boolean => change.has(type))
          .map((change: ChangeLine): ChangeLine => new ChangeLine(change.getLine(), change.getTypes())),
        (item: ChangeLine): number => item.getLine(),
      );
    }

    return changes;
  }

  /**
   * Counts the lines marked changed, added, or removed in the change map.
   *
   * @param {ArrayMap<ChangeLine>} changes - The façade-owned change map
   * @return {number} The number of lines with changes
   */
  public static getChangesLinesCount(changes: ArrayMap<ChangeLine>): number {
    return this.getChanges(changes, [
      ChangeType.changed,
      ChangeType.whitespace,
      ChangeType.added,
      ChangeType.removed,
    ]).size;
  }

  /**
   * Returns the 0-based positions of every changed line, ascending. Defaults to
   * the changed, added, restored, and removed types when none is given.
   *
   * @param {ArrayMap<ChangeLine>} changes - The façade-owned change map
   * @param {ChangeType | ChangeType[]} type - Optional change types to include
   * @return {number[]} The unique changed line positions in ascending order
   */
  public static getChangedPositions(changes: ArrayMap<ChangeLine>, type?: ChangeType | ChangeType[]): number[] {
    const types: ChangeType | ChangeType[] = type ?? [
      ChangeType.changed,
      ChangeType.whitespace,
      ChangeType.added,
      ChangeType.restored,
      ChangeType.removed,
    ];

    return [...this.getChanges(changes, types).keys()]
      .filter((line): line is number => isNumber(line))
      .sort((a: number, b: number): number => a - b);
  }

  /**
   * Recomputes the change map from the ordered tracker. Clears the façade-owned
   * change map and rebuilds it by classifying each tracker line as removed, added,
   * restored, or changed at its current (or removed-at) position. The tracker is
   * passed in by the façade; this collaborator never owns or invalidates it.
   *
   * @param {ArrayMap<ChangeLine>} changes - The façade-owned change map to rebuild
   * @param {ArrayMap<TrackerLine>} tracker - The ordered tracker to classify
   */
  public static updateChanges(changes: ArrayMap<ChangeLine>, tracker: ArrayMap<TrackerLine>): void {
    changes.clear();

    tracker.forEach((lineTracker: TrackerLine): void => {
      /**
       * Skip a missing or ghost tracker entry: it carries no current line to
       * classify, so it contributes nothing to the change map.
       */
      if (!lineTracker || lineTracker.isStateGhost()) {
        return;
      }

      const position: number = lineTracker.isStateRemoved()
        ? lineTracker.removedAtPosition
        : lineTracker.currentPosition;

      const line: ChangeLine = changes.get(position) ?? new ChangeLine(position, []);

      if (!changes.has(position)) {
        changes.set(position, line);
      }

      if (lineTracker.isStateRemoved()) {
        line.add(ChangeType.removed);

        return;
      }

      if (lineTracker.isStateAdded()) {
        line.add(ChangeType.added);

        return;
      }

      if (lineTracker.isStateRestored()) {
        line.add(ChangeType.restored);

        return;
      }

      if (lineTracker.isStateChanged()) {
        const whitespaceOnly: boolean = TextHelper.isWhitespaceDiff(
          lineTracker.original ?? '',
          lineTracker.current ?? '',
        );

        line.add(whitespaceOnly ? ChangeType.whitespace : ChangeType.changed);

        return;
      }
    });
  }
}
