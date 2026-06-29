import type { TrackerLine } from '@/lines/tracker.line';
import { FileSnapshot } from '@/snapshots/file.snapshot';
import { VersionCodec } from '@/snapshots/version-codec';
import type { SerializedFileSnapshot } from '@/types';
import type { TFile } from 'obsidian';

/**
 * Stateless codec that serializes a FileSnapshot into its on-disk plain object
 * and rebuilds one from that object, sitting beside VersionCodec at the snapshot
 * serialization boundary. It holds no state: every method takes the snapshot or
 * the serialized data as an explicit argument, so the domain model exposes plain
 * state and carries none of its own (de)serialization, validation, or defaults.
 *
 * The two directions are inverses and MUST stay byte-compatible with the
 * persisted format: encode writes the HISTORY baseline (so the modal can diff
 * against the original across restarts), the current state, the full tracker, and
 * the delta-encoded version timeline, while decode defensively rebuilds each
 * field so a corrupt or truncated history file degrades to a safe default instead
 * of crashing plugin load.
 */
export class SnapshotCodec {
  /**
   * Serializes a snapshot into a plain object for on-disk persistence. Persists
   * the HISTORY baseline, the current state, and the full tracker so the
   * highlights can be restored verbatim. The session-scoped marker baseline is
   * intentionally not persisted (it is re-established from the file content on the
   * next open) and the change map is omitted because it is recomputed from the
   * tracker on restore.
   *
   * @param {FileSnapshot} snapshot - The snapshot to serialize
   * @return {SerializedFileSnapshot} The plain serialized representation
   */
  public static encode(snapshot: FileSnapshot): SerializedFileSnapshot {
    const payload: SerializedFileSnapshot = {
      path: snapshot.file?.path ?? snapshot.path,
      lineBreak: snapshot.content.lineBreak,
      timestamp: snapshot.timestamp,
      lines: [...snapshot.content.historyLines],
      state: [...snapshot.content.state],
      tracker: snapshot.trackers.getTrackerLines()
        .map((tracker: TrackerLine): ReturnType<TrackerLine['toJSON']> => tracker.toJSON()),
      versions: VersionCodec.encode([...snapshot.timeline.getStoredVersions()], snapshot.content.lineBreak),
    };

    // Optional markers are written only when present so existing live-snapshot
    // payloads round-trip byte-identical and tombstones/moves are explicit.
    if (typeof snapshot.deletedTimestamp === 'number') {
      payload.deletedTimestamp = snapshot.deletedTimestamp;
    }

    if (typeof snapshot.movedIntoAt === 'number') {
      payload.movedIntoAt = snapshot.movedIntoAt;
    }

    return payload;
  }

  /**
   * Rebuilds a snapshot from its serialized form. Reconstructs the marker
   * baseline through the constructor, then replaces the auto-generated tracker and
   * current state with the persisted ones and recomputes the change map. The file
   * reference is attached separately by the caller since serialized data only
   * carries the path.
   *
   * @param {SerializedFileSnapshot} data - The serialized snapshot
   * @param {TFile | null} file - The file this snapshot belongs to, if known
   * @return {FileSnapshot} The reconstructed snapshot
   */
  public static decode(data: SerializedFileSnapshot, file?: TFile | null): FileSnapshot {
    // Defensive deserialization: a corrupt or truncated history.json must not
    // crash plugin load. Each field is guarded individually so a single malformed
    // entry degrades to a safe default instead of throwing.
    const lineBreak: string = typeof data.lineBreak === 'string' ? data.lineBreak : '\n';
    const lines: string[] = Array.isArray(data.lines) ? data.lines : [];
    const tracker: SerializedFileSnapshot['tracker'] = Array.isArray(data.tracker) ? data.tracker : [];
    const state: string[] = Array.isArray(data.state) ? data.state : [];

    const snapshot: FileSnapshot = new FileSnapshot(lines.join(lineBreak), lineBreak, file);

    // The serialized path is the canonical map key. Seed it onto the snapshot so a
    // restored entry whose `file` did not resolve still resolves its folder path
    // without a live `TFile`. A `file`-bearing restore keeps the same value (the
    // key equals `file.path`), so this never disagrees with the constructor seed.
    snapshot.path = typeof data.path === 'string' ? data.path : snapshot.path;
    snapshot.timestamp = typeof data.timestamp === 'number' ? data.timestamp : Date.now();
    snapshot.trackers.restore(tracker);

    // Hand the decoded timeline to its owner, which adopts the array and seeds
    // both cadence gates from it so the interval and edit-count capture cadence
    // stay continuous across a restart (a freshly constructed timeline would
    // otherwise reset both gates to load-time even though recent versions exist).
    snapshot.timeline.restore(VersionCodec.decode(data.versions ?? [], lineBreak));

    if (typeof data.deletedTimestamp === 'number') {
      snapshot.deletedTimestamp = data.deletedTimestamp;
    }

    if (typeof data.movedIntoAt === 'number') {
      snapshot.movedIntoAt = data.movedIntoAt;
    }

    snapshot.content.updateState(state);
    snapshot.updateChanges();

    return snapshot;
  }
}
