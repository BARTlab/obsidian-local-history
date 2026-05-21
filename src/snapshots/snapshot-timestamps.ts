import type { TFile } from 'obsidian';

/**
 * Stateless formatter owning the last-change timestamp concern extracted from
 * FileSnapshot: it resolves the file's last-change moment and renders it as the
 * localized date-time, date, and time strings the history modal displays. It
 * holds no state of its own; every operation takes the façade's file reference
 * and creation timestamp as explicit arguments, mirroring the other snapshot
 * collaborators which never own a private copy of a façade field.
 */
export class SnapshotTimestamps {
  /**
   * Resolves the timestamp of the file's last update. Prefers the file's
   * modification time (the real last-change moment of the live content), and
   * falls back to the snapshot's creation time when no file stat is available
   * (for example a detached snapshot in tests).
   *
   * @param {TFile | null} file - The file reference, if any
   * @param {number} timestamp - The snapshot creation time, used as the fallback
   * @return {number} The last-change timestamp in milliseconds
   */
  public static getLastChangedTimestamp(file: TFile | null | undefined, timestamp: number): number {
    return file?.stat?.mtime ?? timestamp;
  }

  /**
   * Retrieves the last modified date and time as a localized string.
   *
   * @param {TFile | null} file - The file reference, if any
   * @param {number} timestamp - The snapshot creation time, used as the fallback
   * @return {string} The date and time of the last change in a localized string format.
   */
  public static getLastChangedDateTime(file: TFile | null | undefined, timestamp: number): string {
    return new Date(SnapshotTimestamps.getLastChangedTimestamp(file, timestamp)).toLocaleString();
  }

  /**
   * Retrieves the last modified day as a localized date string (no time), used
   * as the day-group key and label for the baseline entry in the history modal.
   *
   * @param {TFile | null} file - The file reference, if any
   * @param {number} timestamp - The snapshot creation time, used as the fallback
   * @return {string} The localized last-change date
   */
  public static getLastChangedDate(file: TFile | null | undefined, timestamp: number): string {
    return new Date(SnapshotTimestamps.getLastChangedTimestamp(file, timestamp)).toLocaleDateString();
  }

  /**
   * Retrieves the last modified time of day as a localized string, shown as the
   * baseline entry's meta once its day lives in the group heading.
   *
   * @param {TFile | null} file - The file reference, if any
   * @param {number} timestamp - The snapshot creation time, used as the fallback
   * @return {string} The localized last-change time
   */
  public static getLastChangedTime(file: TFile | null | undefined, timestamp: number): string {
    return new Date(SnapshotTimestamps.getLastChangedTimestamp(file, timestamp)).toLocaleTimeString();
  }
}
