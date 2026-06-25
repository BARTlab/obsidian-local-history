/**
 * Serialized form of a single TrackerLine, persisted to disk and restored on
 * load. Only the fields needed to rebuild the line's state are stored; the id
 * is intentionally omitted so a fresh, collision-free id is assigned on load.
 */
export interface SerializedTrackerLine {
  originalPosition: number;
  currentPosition: number;
  removedAtPosition: number;
  changeAtPosition: number;
  contentSameOriginal: boolean;
  hash: string | null;
  original: string | null;
  current: string | null;
  removedTimeStamp: number;
  changedTimeStamp: number;
  addedTimeStamp: number;
}

/**
 * Serialized form of a single intermediate version (timeline entry). Holds the
 * captured content and its timestamp; the id is omitted so a fresh one is
 * assigned on restore. The optional `label` is the user-supplied tag that turns
 * a version into a pinned marker (exempt from dedup and eviction). The optional
 * `external` flag marks versions captured from an external-change event:
 * they obey normal retention (not pinned) but get a UI badge so the user can
 * tell git-pull / sync / external-editor states apart from in-editor edits.
 * Both fields are omitted from the payload when unset so existing histories
 * round-trip unchanged.
 *
 * A version entry is keyframe-xor-delta: it carries either `lines` (a keyframe,
 * the full materialized text) or `delta` (a unified-diff string against the
 * preceding entry in the chain), never both and never neither. A current
 * `{ timestamp, lines }` entry is already a valid keyframe, so this shape is a
 * strict superset of the original full-text format. The `label` and
 * `external` flags apply to either form. Runtime dispatch on which form an entry
 * carries lives in the codec, not in this type.
 */
export interface SerializedFileVersion {
  timestamp: number;
  lines?: string[];
  delta?: string;
  label?: string;
  external?: boolean;
}

/**
 * Serialized form of a FileSnapshot. Holds the original baseline, the current
 * state, the full tracker, and the intermediate version timeline so highlights
 * and history can be restored verbatim after a restart. The change map is not
 * stored because it is recomputed from the tracker on load.
 *
 * Optional `deletedTimestamp` flags a tombstone snapshot: the file was
 * deleted in the vault but the snapshot keeps its final state and history so the
 * file remains recoverable. Optional `movedIntoAt` flags the destination side of
 * a cross-directory move: the live snapshot re-keyed to the new path
 * carries this stamp so folder views can colour it as "added in the new folder"
 * while its captured history travels with it. The fields are omitted from the
 * payload when unset so existing histories round-trip unchanged.
 */
export interface SerializedFileSnapshot {
  path: string;
  lineBreak: string;
  timestamp: number;
  lines: string[];
  state: string[];
  tracker: SerializedTrackerLine[];
  versions?: SerializedFileVersion[];
  deletedTimestamp?: number;
  movedIntoAt?: number;
}

/**
 * On-disk shape of the persisted history file. Versioned so the format can
 * evolve without misreading older data.
 */
export interface SerializedHistory {
  version: number;
  snapshots: SerializedFileSnapshot[];
}

/**
 * On-disk shape of a single history shard: one self-describing JSON
 * file per snapshot under the {@link HISTORY_SHARD_DIR} directory, so a corrupt
 * or lost shard costs one note's history instead of the whole base. The shard
 * carries its own `version` (the on-disk format version emitted by
 * `SnapshotsService.serialize()`, not a hardcoded literal) so the version codec
 * can bump it without any shard-level change, and the embedded `snapshot.path`
 * is the read-time identity (the filename is only a hash of that path). The
 * shard is content-agnostic: it never inspects `snapshot.versions[]`, which may
 * hold full-text or delta entries depending on the codec.
 */
export interface SerializedShard {
  version: number;
  snapshot: SerializedFileSnapshot;
}
