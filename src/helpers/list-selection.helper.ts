/**
 * Direction in which to walk a flat selection list with the keyboard. `down`
 * moves toward the end of the list (the visually lower entry), `up` toward the
 * start.
 */
export type ListSelectionDirection = 'up' | 'down';

/**
 * Pure helper backing the history modal's keyboard navigation of the version
 * rail. Given the ordered ids currently shown in the rail and the selected one,
 * it resolves the id the selection moves to for an up/down arrow press.
 *
 * Unlike the diff hunk navigation it does NOT wrap: stepping past either end
 * stays on the edge entry, matching how a plain selectable list behaves under
 * the arrow keys. Keeping the walk here (instead of in the modal) is what lets
 * it be unit tested without the modal DOM.
 */
export class ListSelectionHelper {
  /**
   * Resolves the id the selection moves to when an arrow key is pressed.
   *
   * @param {string[]} ids - The selectable ids in their displayed order
   * @param {string} currentId - The currently selected id
   * @param {ListSelectionDirection} direction - Which way to step
   * @return {string | null} The new selected id, the same id at a list edge, or
   *   null when the list is empty
   */
  public static step(ids: string[], currentId: string, direction: ListSelectionDirection): string | null {
    const list: string[] = ids ?? [];

    if (list.length === 0) {
      return null;
    }

    // A current id missing from the list (for example a selection the rail
    // filter has hidden) starts the walk from the top, so the first arrow press
    // moves back into the visible entries instead of dead-ending.
    const found: number = list.indexOf(currentId);
    const start: number = found === -1 ? 0 : found;
    const next: number = Math.max(0, Math.min(list.length - 1, start + (direction === 'down' ? 1 : -1)));

    return list[next];
  }
}
