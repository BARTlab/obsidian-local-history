import { ChangeType } from '@/consts';
import { isArray } from 'lodash-es';

/**
 * Represents a change to a specific line in a document.
 * Tracks the line number and the types of changes applied to the line.
 * Used to maintain a history of modifications for line-based change tracking.
 */
export class ChangeLine {
  /**
   * Creates a new instance of ChangeLine.
   *
   * @param {number} line - The line number this change applies to
   * @param {ChangeType[]} types - Array of change types applied to this line
   */
  public constructor(
    protected line: number,
    protected types: ChangeType[],
  ) {
  }

  /**
   * Adds a change type to this line if it doesn't already have that type.
   * Prevents duplicate change types for the same line.
   *
   * @param {ChangeType} type - The change type to add
   * @return {void}
   */
  public add(type: ChangeType): void {
    if (!this.has(type)) {
      this.types.push(type);
    }
  }

  /**
   * Checks if this line has a specific change type or any of the types in an array.
   *
   * @param {ChangeType | ChangeType[]} type - A single change type or array of change types to check for
   * @return {boolean} True if the line has any of the specified change types, false otherwise
   */
  public has(type: ChangeType | ChangeType[]): boolean {
    const list: ChangeType[] = isArray(type) ? type : [type];

    return this.types.some((item: ChangeType): boolean => list.includes(item));
  }

  /**
   * Gets all change types applied to this line.
   * Returns a copy of the internal array to prevent direct modification.
   *
   * @return {ChangeType[]} Array of change types applied to this line
   */
  public getTypes(): ChangeType[] {
    return [...this.types];
  }

  /**
   * Gets the first non-removed change type for this line.
   * Used to determine the primary modification type for display purposes.
   *
   * @return {ChangeType | null} The first change type that is not 'removed', or null if none exists
   */
  public getModify(): ChangeType | null {
    return this.types.find((type: ChangeType): boolean => type !== ChangeType.removed) ?? null;
  }

  /**
   * Gets the line number this change applies to.
   *
   * @return {number} The line number
   */
  public getLine(): number {
    return this.line;
  }
}
