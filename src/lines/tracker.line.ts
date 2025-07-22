import { TextHelper } from '@/helpers/text.helper';
import type { TrackerLineParams } from '@/types';
import { isNumber, isString } from 'lodash-es';

/**
 * Represents a tracked line in a document with full history and state tracking.
 * Maintains information about a line's original position, current position, content,
 * and various state flags to determine if it has been added, removed, modified, or restored.
 * Used by the FileSnapshot to track changes to individual lines over time.
 */
export class TrackerLine {
  /** Unique identifier for this tracker line */
  public id: string = TextHelper.rndId();

  /**
   * The original position (line number) in the document
   * Value of -1 indicates the line didn't exist in the original document
   */
  public originalPosition: number = -1;

  /**
   * The current position (line number) in the document
   * Value of -1 indicates the line has been removed
   */
  public currentPosition: number = -1;

  /**
   * The position where the line was removed
   * Shifts when the number of lines in the document changes
   * Value of -1 indicates the line hasn't been removed
   */
  public removedAtPosition: number = -1;

  /**
   * The position where the line was last changed
   * Does NOT shift when the number of lines in the document changes
   * Value of -1 indicates the line hasn't been changed
   */
  public changeAtPosition: number = -1;

  /**
   * Whether the current content is the same as in the original document
   * Used to determine if a line has been restored to its original state
   */
  public contentSameOriginal: boolean = false;

  /**
   * Hash of the line content
   * Used for efficient content comparison
   */
  public hash: string = null;

  /**
   * Original content of the line (for development use only)
   */
  public original: string = null;

  /**
   * Current content of the line (for development use only)
   */
  public current: string = null;

  /**
   * Timestamp when the line was removed
   * Used for sorting and tracking removal order
   * Value of -1 indicates the line hasn't been removed
   */
  public removedTimeStamp: number = -1;

  /**
   * Timestamp when the line was last changed
   * Used for sorting and tracking change order
   * Value of -1 indicates the line hasn't been changed
   */
  public changedTimeStamp: number = -1;

  // todo: remove or use it
  /**
   * Timestamp when the line was added
   * Used for sorting and tracking addition order
   */
  public addedTimeStamp: number = Date.now();

  /**
   * Gets a unique key for this tracker line.
   * Combines position information with a prefix indicating if the line exists in the current document,
   * and the line's unique ID.
   *
   * @return {string} A string key that uniquely identifies this line
   */
  public get key(): string {
    const prefix: string = this.existedInCurrent ? 'crn' : 'org';
    const position: string = String(
      Math.max(this.originalPosition, this.currentPosition)
    ).padStart(4, '0');

    return `${position}-${prefix}-${this.id}`;
  }

  /**
   * Checks if the line has been explicitly removed.
   * Does not consider whether the line existed in the original document.
   *
   * @return {boolean} True if the line has been removed, false otherwise
   */
  public get wasExplicitlyRemoved(): boolean {
    return this.removedAtPosition !== -1;
  }

  /**
   * Checks if the line has been explicitly changed.
   * Does not consider whether the line existed in the original document.
   *
   * @return {boolean} True if the line has been changed, false otherwise
   */
  public get wasExplicitlyChanged(): boolean {
    return this.changeAtPosition !== -1;
  }

  /**
   * Checks if the line existed in the original document.
   *
   * @return {boolean} True if the line existed in the original document, false otherwise
   */
  public get existedInOriginal(): boolean {
    return this.originalPosition !== -1;
  }

  /**
   * Checks if the line exists in the current document.
   *
   * @return {boolean} True if the line exists in the current document, false otherwise
   */
  public get existedInCurrent(): boolean {
    return this.currentPosition !== -1;
  }

  /**
   * Checks if the line has a content hash.
   * Used to determine if content comparison is possible.
   *
   * @return {boolean} True if the line has a content hash, false otherwise
   */
  public get contentHashed(): boolean {
    return isString(this.hash) && !!this.hash;
  }

  /**
   * Creates a new instance of TrackerLine.
   * Initializes the line tracker with optional parameters for content and position.
   *
   * @param {TrackerLineParams} params - Optional parameters to initialize the tracker line
   */
  public constructor(params?: TrackerLineParams) {
    const {
      content,
      originalPosition,
      currentPosition,
      contentSameOriginal,
    } = params ?? {};

    if (isNumber(originalPosition)) {
      this.originalPosition = originalPosition;
    }

    if (isNumber(currentPosition)) {
      this.currentPosition = currentPosition;
    }

    if (isString(content)) {
      this.current = content;
      this.hash = TextHelper.hash(content);
    }

    if (contentSameOriginal === true) {
      this.original = content;
      this.contentSameOriginal = this.existedInOriginal && this.contentHashed;
    }
  }

  /**
   * Checks if this tracker line is equal to another tracker line.
   * Lines are considered equal if they are the same instance or have the same ID.
   *
   * @param {TrackerLine} item - The tracker line to compare with
   * @return {boolean} True if the lines are equal, false otherwise
   */
  public isEq(item: TrackerLine): boolean {
    return item === this || item.id === this.id;
  }

  /**
   * Checks if this line is a "ghost" line.
   * A ghost line is one that didn't exist in the original document and was later removed.
   *
   * @return {boolean} True if the line is a ghost line, false otherwise
   */
  public isStateGhost(): boolean {
    return !this.existedInOriginal && !this.existedInCurrent && this.wasExplicitlyRemoved;
  }

  /**
   * Checks if this line has been removed.
   * A removed line existed in the original document but no longer exists in the current document.
   *
   * @return {boolean} True if the line has been removed, false otherwise
   */
  public isStateRemoved(): boolean {
    return !this.existedInCurrent && this.existedInOriginal && this.wasExplicitlyRemoved;
  }

  /**
   * Checks if this line was removed at a specific position.
   *
   * @param {number} line - The line number to check
   * @return {boolean} True if the line was removed at the specified position, false otherwise
   */
  public isStateRemovedAt(line: number): boolean {
    return !this.existedInCurrent && this.existedInOriginal && this.removedAtPosition === line;
  }

  /**
   * Checks if this line has been added.
   * An added line didn't exist in the original document but exists in the current document.
   *
   * @return {boolean} True if the line has been added, false otherwise
   */
  public isStateAdded(): boolean {
    return !this.existedInOriginal && !this.wasExplicitlyRemoved && this.existedInCurrent;
  }

  /**
   * Checks if this line has been changed.
   * A changed line existed in the original document, exists in the current document,
   * has different content from the original, and has not been removed.
   *
   * @return {boolean} True if the line has been changed, false otherwise
   */
  public isStateChanged(): boolean {
    return this.existedInOriginal &&
      this.existedInCurrent &&
      !this.contentSameOriginal &&
      !this.wasExplicitlyRemoved &&
      this.wasExplicitlyChanged;
  }

  /**
   * Checks if this line is in its original state.
   * An original line existed in the original document, has the same content as the original,
   * and has not been removed.
   *
   * @return {boolean} True if the line is in its original state, false otherwise
   */
  public isStateOriginal(): boolean {
    return this.existedInOriginal && this.contentSameOriginal && !this.wasExplicitlyRemoved;
  }

  /**
   * Checks if this line has been restored to its original state.
   * A restored line has the same content as the original, has not been removed,
   * but has been explicitly changed at some point.
   *
   * @return {boolean} True if the line has been restored, false otherwise
   */
  public isStateRestored(): boolean {
    return this.contentSameOriginal && !this.wasExplicitlyRemoved && this.wasExplicitlyChanged;
  }

  /**
   * Checks if this line is currently at a specific position.
   *
   * @param {number} line - The line number to check
   * @return {boolean} True if the line is currently at the specified position, false otherwise
   */
  public isCurrentAt(line: number): boolean {
    return this.currentPosition === line;
  }

  /**
   * Checks if this line's current position is greater than a specific line number.
   *
   * @param {number} line - The line number to compare with
   * @return {boolean} True if the line's current position is greater than the specified line number, false otherwise
   */
  public isCurrentGT(line: number): boolean {
    return this.currentPosition > line;
  }

  /**
   * Checks if this line's current position is less than a specific line number.
   *
   * @param {number} line - The line number to compare with
   * @return {boolean} True if the line's current position is less than the specified line number, false otherwise
   */
  public isCurrentLT(line: number): boolean {
    return this.currentPosition < line;
  }

  /**
   * Gets the offset between a specified line number and this line's current position.
   * Used to determine how far to shift the line when moving it.
   *
   * @param {number} line - The line number to calculate the offset from
   * @return {number} The offset (positive or negative) between the specified line number and this line's
   *   current position
   */
  public getCurrentPositionOffset(line: number): number {
    return line - this.currentPosition;
  }

  /**
   * Checks if this line was originally at a specific position.
   *
   * @param {number} line - The line number to check
   * @return {boolean} True if the line was originally at the specified position, false otherwise
   */
  public isOriginAt(line: number): boolean {
    return this.originalPosition === line;
  }

  /**
   * Checks if this line's original position is within a specified range.
   * If no upper bound is provided, checks if the original position is greater than or equal to the lower bound.
   *
   * @param {number} from - The lower bound of the range (inclusive)
   * @param {number} to - The upper bound of the range (inclusive), optional
   * @return {boolean} True if the line's original position is within the specified range, false otherwise
   */
  public isOriginalInRange(from: number, to?: number): boolean {
    return this.originalPosition >= from && (!to || this.originalPosition <= to);
  }

  /**
   * Checks if this line's current position is within a specified range.
   * If no upper bound is provided, checks if the current position is greater than or equal to the lower bound.
   *
   * @param {number} from - The lower bound of the range (inclusive)
   * @param {number} to - The upper bound of the range (inclusive), optional
   * @return {boolean} True if the line's current position is within the specified range, false otherwise
   */
  public isCurrentInRange(from: number, to?: number): boolean {
    return this.currentPosition >= from && (!to || this.currentPosition <= to);
  }

  /**
   * Checks if this line's removed position is within a specified range.
   * If no upper bound is provided, checks if the removed position is greater than or equal to the lower bound.
   * Used to determine if a line was removed within a specific range of lines.
   *
   * @param {number} from - The lower bound of the range (inclusive)
   * @param {number} to - The upper bound of the range (inclusive), optional
   * @return {boolean} True if the line's removed position is within the specified range, false otherwise
   */
  public isRemoveInRange(from: number, to?: number): boolean {
    return this.removedAtPosition >= from && (!to || this.removedAtPosition <= to);
  }

  /**
   * Moves this line to a new position in the document.
   * Updates the current position and change position, but only if the line exists in the current document.
   *
   * @param {number} line - The new line number to move to
   */
  public moveTo(line: number): void {
    if (!this.existedInCurrent) {
      return;
    }

    this.currentPosition = line;
    this.changeAtPosition = line;
    // todo: not sure if it's needed here
    // this.removedAtPosition = -1;
  }

  /**
   * Restores a previously removed line.
   * Sets the current position to the specified line number or the original removed position,
   * and clears the removed flags.
   * Only works for lines that existed in the original document.
   *
   * @param {number} line - Optional new line number to restore to (defaults to the removed position)
   * @return {this} This tracker line instance for method chaining
   */
  public restore(line?: number): this {
    if (!this.existedInOriginal) {
      return this;
    }

    this.currentPosition = line ?? this.removedAtPosition;
    this.changeAtPosition = line ?? this.removedAtPosition;
    this.removedAtPosition = -1;
    this.removedTimeStamp = -1;

    return this;
  }

  /**
   * Marks this line as removed.
   * Records the position where it was removed and sets the current position to -1.
   * Does nothing if the line is already marked as removed.
   *
   * @param {number} line - Optional line number where the removal occurred (defaults to current position)
   * @return {this} This tracker line instance for method chaining
   */
  public remove(line?: number): this {
    if (this.wasExplicitlyRemoved) {
      return this;
    }

    // Remember the removal position
    this.removedAtPosition = line ?? this.currentPosition;

    // Line no longer exists
    this.currentPosition = -1;
    this.removedTimeStamp = Date.now();

    return this;
  }

  /**
   * Changes the content of this line.
   * Updates the content hash, checks if the content matches the original,
   * and records the change position and timestamp.
   * Does nothing if the content is not a string or if the line doesn't exist in the current document.
   *
   * @param {string} content - The new content for the line
   * @param {number} line - Optional line number where the change occurred (defaults to current position)
   */
  public change(content: string, line?: number): void {
    if (!isString(content) || !this.existedInCurrent) {
      return;
    }

    const hash: string = TextHelper.hash(content);

    if (hash === this.hash && this.contentSameOriginal) {
      return;
    }

    this.current = content;

    this.contentSameOriginal = this.hash === hash;
    this.changeAtPosition = line ?? this.currentPosition;
    this.changedTimeStamp = Date.now();
  }

  /**
   * Shifts this line's position up by the specified offset.
   * Increases both the current position and removed position (if applicable) by the offset.
   * Used when lines are added to the document above this line.
   *
   * @param {number} offset - The number of lines to shift up (defaults to 1)
   */
  public shiftUp(offset: number = 1): void {
    if (this.existedInCurrent) {
      this.currentPosition += offset;
    }

    // Also shift removed lines
    if (this.existedInOriginal && this.wasExplicitlyRemoved
    ) {
      this.removedAtPosition += offset;
    }
  }

  /**
   * Shifts this line's position down by the specified offset.
   * Decreases both the current position and removed position (if applicable) by the offset.
   * Used when lines are removed from the document above this line.
   *
   * @param {number} offset - The number of lines to shift down (defaults to 1)
   */
  public shiftDown(offset: number = 1): void {
    if (this.existedInCurrent) {
      this.currentPosition -= offset;
    }

    // Also shift removed lines
    if (this.existedInOriginal && this.wasExplicitlyRemoved) {
      this.removedAtPosition -= offset;
    }
  }
}
