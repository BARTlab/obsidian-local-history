import { TextHelper } from '@/helpers/text.helper';
import type { SerializedFileVersion } from '@/types';

/**
 * An immutable, point-in-time snapshot of a file's text captured between the
 * original baseline and the live current state. Versions form the timeline the
 * history modal can diff against, mirroring native version history but local.
 *
 * Only the text is stored (not a full tracker): a version is a frozen copy of
 * the content at capture time, which is all the diff view needs to compare an
 * earlier point against the current state.
 */
export class FileVersion {
  /**
   * Unique identifier for this version, generated on creation. Used as a stable
   * key for the version list in the UI and to address a picked diff base.
   */
  public id: string = TextHelper.rndId();

  /**
   * Timestamp (ms) when this version was captured.
   */
  public timestamp: number = Date.now();

  /**
   * The file content at capture time, as an array of lines.
   */
  public lines: string[] = [];

  /**
   * Optional user-supplied tag that turns this version into a pinned marker.
   * When set, the version is exempt from the duplicate-skip on capture and from
   * the age/count eviction passes, so an intentionally labeled point cannot
   * silently vanish from the timeline (see D6).
   */
  public label?: string;

  /**
   * Creates a new immutable version from a content snapshot.
   *
   * @param {string[]} lines - The file content at capture time, split into lines
   * @param {number} timestamp - Optional capture timestamp (defaults to now)
   * @param {string} label - Optional user-supplied tag pinning this version
   */
  public constructor(lines: string[], timestamp?: number, label?: string) {
    this.lines = [...(lines ?? [])];

    if (typeof timestamp === 'number') {
      this.timestamp = timestamp;
    }

    if (typeof label === 'string' && label.length > 0) {
      this.label = label;
    }
  }

  /**
   * Whether this version carries a user-supplied label and is therefore pinned
   * (exempt from the duplicate-skip and eviction).
   *
   * @return {boolean} True when a non-empty label is set
   */
  public isLabeled(): boolean {
    return typeof this.label === 'string' && this.label.length > 0;
  }

  /**
   * Gets the captured content as a string joined by the given line break.
   *
   * @param {string} lineBreak - The line break to join lines with
   * @return {string} The captured content as a single string
   */
  public getContent(lineBreak: string): string {
    return this.lines.join(lineBreak);
  }

  /**
   * Gets a copy of the captured lines so callers cannot mutate the version.
   *
   * @return {string[]} A copy of the captured content lines
   */
  public getLines(): string[] {
    return [...this.lines];
  }

  /**
   * Gets the capture date and time as a localized string for display.
   *
   * @return {string} The localized capture date and time
   */
  public getDateTime(): string {
    return new Date(this.timestamp).toLocaleString();
  }

  /**
   * Gets the capture day as a localized date string, used both as the label and
   * the grouping key for the day-grouped version list. Two versions captured on
   * the same calendar day yield the same string.
   *
   * @return {string} The localized capture date (no time)
   */
  public getDate(): string {
    return new Date(this.timestamp).toLocaleDateString();
  }

  /**
   * Gets the capture time of day as a localized string. Shown as the per-version
   * meta once the day lives in the group heading, so the time is not repeated
   * with a redundant date.
   *
   * @return {string} The localized capture time
   */
  public getTime(): string {
    return new Date(this.timestamp).toLocaleTimeString();
  }

  /**
   * Serializes this version into a plain object for on-disk persistence.
   * The id is intentionally omitted so a fresh, collision-free id is assigned
   * on restore (matching how tracker lines are persisted).
   *
   * @return {SerializedFileVersion} The plain serialized representation
   */
  public toJSON(): SerializedFileVersion {
    const data: SerializedFileVersion = {
      timestamp: this.timestamp,
      lines: [...this.lines],
    };

    if (this.isLabeled()) {
      data.label = this.label;
    }

    return data;
  }

  /**
   * Rebuilds a version from its serialized form, assigning a fresh id.
   *
   * @param {SerializedFileVersion} data - The serialized version
   * @return {FileVersion} The reconstructed version
   */
  public static fromJSON(data: SerializedFileVersion): FileVersion {
    return new FileVersion(
      Array.isArray(data?.lines) ? data.lines : [],
      data?.timestamp,
      typeof data?.label === 'string' ? data.label : undefined,
    );
  }
}
