import type { Editor } from 'obsidian';
import { NavigationDirection } from '@/consts';

/**
 * Pure helper that picks the changed line a navigation command should jump to.
 *
 * The plugin tracks changed lines as 0-based positions (the same positions the
 * line decorations are keyed by). Given that set and the current cursor line,
 * this helper resolves the next or previous changed line. It is deliberately
 * free of any editor or Obsidian dependency so the target-selection logic can
 * be unit tested in isolation, while the command shells only translate the
 * result into a real cursor move.
 *
 * Wrap-around is enabled: walking past the last change returns the first, and
 * walking before the first change returns the last, so repeated invocations
 * cycle through every change without dead-ending.
 */
export class NavigationHelper {
  /**
   * Resolves the changed line to navigate to from the current cursor line.
   * Targets are strictly after (for 'next') or strictly before (for
   * 'previous') the cursor, so a cursor already sitting on a changed line still
   * advances to a different one. With nothing strictly in the requested
   * direction the search wraps to the opposite end of the set.
   *
   * @param {number[]} changedLines - The 0-based changed line positions, in any
   *   order and possibly with duplicates
   * @param {number} cursorLine - The 0-based line the cursor is currently on
   * @param {NavigationDirection} direction - Which way to walk the set
   * @return {number | null} The 0-based target line, or null when there are no
   *   changed lines to navigate to
   */
  public static target(
    changedLines: number[],
    cursorLine: number,
    direction: NavigationDirection,
  ): number | null {
    const sorted: number[] = NavigationHelper.normalize(changedLines);

    if (sorted.length === 0) {
      return null;
    }

    if (direction === NavigationDirection.next) {
      const ahead: number | undefined = sorted.find((line: number): boolean => line > cursorLine);

      // Wrap to the first change when nothing lies strictly after the cursor.
      return ahead ?? sorted[0];
    }

    const before: number | undefined = [...sorted]
      .reverse()
      .find((line: number): boolean => line < cursorLine);

    // Wrap to the last change when nothing lies strictly before the cursor.
    return before ?? sorted[sorted.length - 1];
  }

  /**
   * Moves the editor cursor to the start of a 0-based target line and scrolls
   * it into view. The line is clamped into the document's range and the column
   * to that line's length, so a stale target (for example a changed line that
   * no longer exists) can never throw or land off the document.
   *
   * @param {Editor} editor - The editor to move the cursor in
   * @param {number} line - The 0-based line to place the cursor on
   */
  public static moveCursor(editor: Editor, line: number): void {
    const lastLine: number = editor.lastLine();
    const targetLine: number = Math.max(0, Math.min(lastLine, line));
    const column: number = editor.getLine(targetLine).length;

    /**
     * Land at the start of the changed line and center it in the viewport. The
     * scroll range spans the whole line so the indicator is comfortably shown.
     */
    editor.setCursor({ line: targetLine, ch: 0 });
    editor.scrollIntoView({
      from: { line: targetLine, ch: 0 },
      to: { line: targetLine, ch: column },
    }, true);
  }

  /**
   * Sorts the changed line positions ascending and drops duplicates and any
   * non-finite entries, yielding the canonical ordered set the target search
   * relies on.
   *
   * @param {number[]} changedLines - The raw changed line positions
   * @return {number[]} The unique, ascending, finite line positions
   */
  protected static normalize(changedLines: number[]): number[] {
    return [...new Set(changedLines ?? [])]
      .filter((line: number): boolean => Number.isFinite(line))
      .sort((a: number, b: number): number => a - b);
  }
}
