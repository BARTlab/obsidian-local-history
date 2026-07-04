import { ChangeType } from '@/consts';
import * as TextHelper from '@/helpers/text.helper';
import { ChangeLine } from '@/lines/change.line';
import type { TrackerLine } from '@/lines/tracker.line';
import { ArrayMap } from '@/maps/array.map';

/**
 * Owns the content/baselines/changes concern FileSnapshot exposes as
 * `snapshot.content`: the marker baseline (`lines`), the history baseline
 * (`historyLines`), the current state (`state`) and its hash (`lastHash`), the
 * change map (`changes`), and the line break used to join and split them. The
 * fields live here, not on the façade, so no operation threads them in as a
 * parameter and callers cannot pass mismatched arrays. Callers reach the
 * state/baseline/change queries through this sub-object; the façade only rewires
 * its own composite operations (construction, serialization, marker-baseline
 * reset, change-map refresh, history adoption) to read and write this owner.
 */
export class SnapshotState {
  /**
   * Marker baseline: the file content the change tracker measures against, the
   * session origin the gutter markers compare the current state to. Seeded from
   * the constructed content and re-established at the current state by the
   * façade's marker-baseline reset.
   */
  public lines: string[] = [];

  /**
   * History baseline: the persisted original the history modal diffs against.
   * Starts equal to the marker baseline; a restore overrides only this baseline
   * (through adoptHistory) so the gutter stays session-scoped while the modal
   * still diffs against the persisted original.
   */
  public historyLines: string[] = [];

  /**
   * Current content of the file as an array of lines: the most recent state,
   * refreshed by updateState which also recomputes the hash.
   */
  public state: string[] = [];

  /**
   * Map of line numbers to their change information (added, changed, removed,
   * restored). Rebuilt from the ordered tracker by updateChanges.
   */
  public changes: ArrayMap<ChangeLine> = new ArrayMap();

  /**
   * Hash of the last known state, used as a cheap change-detection pre-filter.
   */
  public lastHash: string | null = null;

  /**
   * Line break used to JOIN the owned line arrays back into content (hashing,
   * comparison, disk writes). Incoming content is always split on `/\r?\n/`, so a
   * mixed-ending document decomposes into the same lines the editor sees; this
   * convention only decides how those lines are rejoined. Defaults to '\n'.
   */
  public lineBreak: string = '\n';

  /**
   * Seeds the owned content from the initial file text: splits it into the marker
   * baseline, copies that into the history baseline, and records the first state
   * and its hash. A restore later overrides the history baseline independently.
   *
   * @param {string} content - The initial file content as a string
   * @param {string} lineBreak - The line break used to rejoin the owned lines
   */
  public constructor(content?: string, lineBreak?: string) {
    if (lineBreak) {
      this.lineBreak = lineBreak;
    }

    // Split on `/\r?\n/`, not `lineBreak`: a file with mixed CRLF and lone-LF
    // endings must decompose into the same lines the change detector and editor
    // see, otherwise the baseline holds fewer lines than the live document.
    this.lines = content?.split(/\r?\n/) ?? [];
    this.historyLines = [...this.lines];
    this.updateState(this.lines);
  }

  /**
   * Updates the current state from new content and refreshes the hash used for
   * change detection. Accepts either a joined string or an array of lines.
   *
   * @param {string | string[]} content - The new content, as a string or lines
   */
  public updateState(content: string | string[]): void {
    // A string is split on `/\r?\n/` (not `lineBreak`) for the same reason the
    // baseline is: mixed endings must yield the same lines the editor sees. The
    // join back below stays on `lineBreak`, the write-back convention.
    this.state = Array.isArray(content) ? [...content] : content.split(/\r?\n/);
    this.lastHash = TextHelper.hash(this.state.join(this.lineBreak));
  }

  /**
   * Whether the current state equals the marker baseline (the session origin the
   * gutter markers measure against).
   *
   * @return {boolean} True when the current state matches the marker baseline
   */
  public isStateSameOriginal(): boolean {
    return this.getOriginalState() === this.getLastState();
  }

  /**
   * Joins the current state lines into a string.
   *
   * @return {string} The current state as a string
   */
  public getLastState(): string {
    return this.state.join(this.lineBreak);
  }

  /**
   * Returns a copy of the current state lines so callers cannot mutate the field.
   *
   * @return {string[]} A copy of the current state lines
   */
  public getLastStateLines(): string[] {
    return [...this.state];
  }

  /**
   * Joins the marker baseline lines (the session origin the gutter markers
   * measure against) into a string.
   *
   * @return {string} The marker baseline as a string
   */
  public getOriginalState(): string {
    return [...this.lines].join(this.lineBreak);
  }

  /**
   * Returns a copy of the marker baseline lines so callers cannot mutate the field.
   *
   * @return {string[]} A copy of the marker baseline lines
   */
  public getOriginalStateLines(): string[] {
    return [...this.lines];
  }

  /**
   * Joins the history baseline lines (the persisted original the history modal
   * diffs against) into a string.
   *
   * @return {string} The history baseline as a string
   */
  public getHistoryOriginalState(): string {
    return [...this.historyLines].join(this.lineBreak);
  }

  /**
   * Returns a copy of the history baseline lines so callers cannot mutate the field.
   *
   * @return {string[]} A copy of the history baseline lines
   */
  public getHistoryOriginalStateLines(): string[] {
    return [...this.historyLines];
  }

  /**
   * Adopts a persisted history baseline as a defensive copy, leaving the marker
   * baseline, the current state, and the change map untouched. Non-array input
   * collapses to an empty array, matching the original guard.
   *
   * @param {string[]} historyLines - The persisted original (history baseline)
   */
  public adoptHistory(historyLines: string[]): void {
    this.historyLines = Array.isArray(historyLines) ? [...historyLines] : [];
  }

  /**
   * Returns the owned change map, optionally filtered to the given change types.
   * When a type filter is given a fresh filtered ArrayMap is returned, otherwise
   * the live owned map is returned for direct use.
   *
   * @param {ChangeType | ChangeType[]} type - Optional change types to filter by
   * @return {ArrayMap<ChangeLine>} The change map, filtered when a type is given
   */
  public getChanges(type?: ChangeType | ChangeType[]): ArrayMap<ChangeLine> {
    if (!this.changes) {
      this.changes = new ArrayMap<ChangeLine>();
    }

    if (type) {
      return ArrayMap.make(
        this.changes
          .filter((change: ChangeLine): boolean => change.has(type))
          .map((change: ChangeLine): ChangeLine => new ChangeLine(change.getLine(), change.getTypes())),
        (item: ChangeLine): number => item.getLine(),
      );
    }

    return this.changes;
  }

  /**
   * Counts the lines marked changed, added, or removed in the owned change map.
   *
   * @return {number} The number of lines with changes
   */
  public getChangesLinesCount(): number {
    return this.getChanges([
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
   * @param {ChangeType | ChangeType[]} type - Optional change types to include
   * @return {number[]} The unique changed line positions in ascending order
   */
  public getChangedPositions(type?: ChangeType | ChangeType[]): number[] {
    const types: ChangeType | ChangeType[] = type ?? [
      ChangeType.changed,
      ChangeType.whitespace,
      ChangeType.added,
      ChangeType.restored,
      ChangeType.removed,
    ];

    return [...this.getChanges(types).keys()]
      .filter((line): line is number => typeof line === 'number')
      .sort((a: number, b: number): number => a - b);
  }

  /**
   * Recomputes the owned change map from the ordered tracker. Clears the map and
   * rebuilds it by classifying each tracker line as removed, added, restored, or
   * changed at its current (or removed-at) position. The tracker belongs to the
   * tracker sub-object and is passed in by the façade; this owner classifies it
   * into its own change map without owning the tracker.
   *
   * @param {ArrayMap<TrackerLine>} tracker - The ordered tracker to classify
   */
  public updateChanges(tracker: ArrayMap<TrackerLine>): void {
    const changes: ArrayMap<ChangeLine> = this.getChanges();

    changes.clear();

    tracker.forEach((lineTracker: TrackerLine): void => {
      // Skip a missing or ghost tracker entry: it carries no current line to
      // classify, so it contributes nothing to the change map.
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
