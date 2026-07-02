import type { FileSnapshot } from '@/snapshots/file.snapshot';
import type { HistorySerializerHost } from '@/snapshots/history-serializer.types';
import { SnapshotCodec } from '@/snapshots/snapshot-codec';
import type { SnapshotRegistry } from '@/snapshots/snapshot-registry';
import type { SerializedFileSnapshot, SerializedHistory } from '@/types';
import type { TFile } from 'obsidian';

/**
 * Plain collaborator that owns the history serialization concern of
 * {@link SnapshotsService}: turning the tracked snapshots into a persistable
 * payload and rebuilding them from one, including tombstone inclusion, the
 * session-marker-baseline preservation on re-open, the orphan (missing-file)
 * reconstruction, and the post-restore open-file reconcile pass.
 *
 * It is instantiated and owned by the service (not a DI service), so the DI
 * container's `constructor.name` resolution and registration ordering are
 * untouched. It works directly against the {@link SnapshotRegistry} for the
 * snapshot map and reaches the plugin (file lookup, open files, external-capture
 * scheduling) through a narrow {@link HistorySerializerHost} port, keeping the
 * service the sole owner of the plugin handle and the sibling collaborators.
 */
export class HistorySerializer {
  /**
   * Creates a new HistorySerializer bound to the registry it serializes and its
   * owning service's host port.
   *
   * @param {SnapshotRegistry} registry - The snapshot map to serialize/restore
   * @param {HistorySerializerHost} host - The narrow port onto the plugin deps
   */
  public constructor(
    protected registry: SnapshotRegistry,
    protected host: HistorySerializerHost,
  ) {
  }

  /**
   * Serializes all tracked snapshots into a plain, persistable structure.
   * Includes live snapshots that carry actual history (a tracker with changes
   * or a non-empty intermediate-version timeline) so pristine files do not
   * bloat the store but a timeline is never lost just because the current
   * state happens to match the original. Tombstones are ALWAYS included
   * regardless of tracker/timeline emptiness: their final state plus
   * `deletedTimestamp` is the only record of a deleted file's content and must
   * survive a restart even when the live tracker was reset on `markDeleted`.
   *
   * The serialized `path` is taken from the map key (not from `snapshot.file`)
   * so tombstones whose `file` reference is null (cross-directory move leaves
   * a detached tombstone) still round-trip to disk under their last-known
   * path.
   *
   * @return {SerializedHistory} The versioned, serializable history payload
   */
  public serialize(): SerializedHistory {
    const snapshots: SerializedFileSnapshot[] = [];

    for (const [path, snapshot] of this.registry.entries()) {
      if (!path) {
        continue;
      }

      const isTombstone: boolean = snapshot.isTombstone();
      const hasHistory: boolean = snapshot.content.getChangesLinesCount() > 0 || snapshot.timeline.hasVersions();

      /**
       * Tombstones are kept unconditionally; live snapshots only when they
       * carry real history. The map key wins over snapshot.file?.path so a
       * detached tombstone (file = null) still serializes under its path.
       */
      if (!isTombstone && !hasHistory) {
        continue;
      }

      /**
       * Isolate per-file serialization failure: a single corrupt snapshot whose
       * `SnapshotCodec.encode` (or its version encode) throws must drop only that file, never
       * abort the whole loop. An unguarded throw here would propagate out of
       * `serialize()` and lose the ENTIRE vault's payload for that save, which
       * the persistence layer could then misread (an empty/failed payload) and
       * act on destructively. Skipping the bad entry keeps every other file's
       * history intact.
       */
      let payload: SerializedFileSnapshot;

      try {
        payload = SnapshotCodec.encode(snapshot);
      } catch (error) {
        console.error('Local history: failed to serialize snapshot; skipping it', path, error);

        continue;
      }

      payload.path = path;

      snapshots.push(payload);
    }

    /**
     * Format version 2 signals "may contain delta entries" in versions[].
     * It is purely advisory: decode dispatches per entry on `lines` vs `delta`
     * (VersionCodec.decode), so version-1 (all-keyframe) and version-2
     * (delta-bearing) files restore identically and no reader branches on it.
     */
    return { version: 2, snapshots };
  }

  /**
   * Restores snapshots from a previously serialized history payload, keeping the
   * marker and history baselines separate.
   *
   * When the file was already captured this session, its session snapshot owns
   * the MARKER baseline (the file content at this open) plus the live tracker and
   * state, which must stay session-scoped so the gutter does not mark the whole
   * file after a restart. The persisted HISTORY baseline and version timeline are
   * adopted into that session snapshot, so the modal still diffs against the
   * original and its captured versions without touching the markers.
   *
   * When the file is not open this session there is no session marker baseline to
   * preserve, so the snapshot is rebuilt verbatim (marker and history baselines
   * coincide).
   *
   * When the live file is gone (deleted while the plugin was off, or the entry
   * was already a tombstone on disk) the snapshot is reconstructed as a
   * tombstone under its persisted path so deleted-file history is never silently
   * dropped on restart:
   *
   *   - a payload that already carries `deletedTimestamp` is rebuilt as that
   *     same tombstone (the original deletion moment is preserved);
   *   - a live payload whose file no longer resolves is auto-tombstoned with
   *     `deletedTimestamp = data.timestamp`, treating the offline disappearance
   *     as a delete that happened at the snapshot's last-known moment.
   *
   * Auto-tombstoning runs from `restoreFromDisk`, which itself runs from
   * `onLayoutReady`, so the vault file index is fully populated by the time
   * `getFileByPath` is consulted; a null result is a real absence, not a
   * transient indexing miss.
   *
   * After the restore loop, any file currently open in the editor is
   * re-checked via {@link scheduleExternalCapture} to catch a disk state that
   * diverged from the restored snapshot state while the plugin was off (A1).
   * Files not open in the editor are intentionally skipped (no disk read for
   * unopened files). The debounce inside {@link scheduleExternalCapture} also
   * coalesces any vault.modify event that fires immediately after restore into a
   * single trailing pass, preventing double-capture.
   *
   * @param {SerializedFileSnapshot[]} snapshots - The serialized snapshots
   */
  public restore(snapshots: SerializedFileSnapshot[]): void {
    if (!Array.isArray(snapshots)) {
      return;
    }

    for (const data of snapshots) {
      if (!data?.path) {
        continue;
      }

      const file: TFile | null = this.host.getFileByPath(data.path);

      if (!file) {
        this.restoreOrphan(data);

        continue;
      }

      const existing: FileSnapshot | undefined = this.registry.get(data.path);

      if (existing) {
        /**
         * Preserve the session marker baseline, tracker, and state; adopt only
         * the persisted history baseline and versions so the modal regains its
         * time machine while the gutter stays session-scoped.
         */
        const persisted: FileSnapshot = SnapshotCodec.decode(data, file);

        existing.adoptHistory(
          persisted.content.getHistoryOriginalStateLines(),
          [...persisted.timeline.getStoredVersions()],
          persisted.deletedTimestamp,
        );
        this.registry.forceUpdate();

        continue;
      }

      /**
       * A file that exists but was not captured this session yet: reconstruct it
       * from disk, then collapse its session marker baseline onto the current
       * state so it starts session-clean. Without this the restored snapshot
       * carries its full history diff and the tree/tab decorator (which reads
       * snapshots without opening them) would paint its folder as changed on a
       * fresh launch, before the user edits anything this session.
       */
      const restored: FileSnapshot = SnapshotCodec.decode(data, file);

      restored.resetMarkerBaseline();
      this.registry.set(data.path, restored);
    }

    this.reconcileOpenFiles();
  }

  /**
   * Re-checks the disk state for every file currently open in the editor after
   * a restore pass (A1). Calls {@link scheduleExternalCapture} for each open
   * file that has a snapshot, which debounces the disk read + hash compare and
   * fires a capture only when the on-disk content diverges from the restored
   * state. Files not open in the editor are intentionally skipped: there is no
   * visible editor surface for them and the performance cost of reading every
   * tracked file on startup would be prohibitive.
   *
   * The debounce window inside {@link ExternalChangeCapture} acts as an
   * async-safety valve: if a vault.modify event fires for the same file
   * immediately after restore, its scheduleExternalCapture call resets the
   * timer, so the two triggers coalesce into a single trailing disk read
   * rather than a double-capture.
   *
   * A no-op when the plugin does not yet expose its open files (test stubs or
   * very early init paths that do not need the workspace), which the host
   * surfaces as an empty set.
   */
  protected reconcileOpenFiles(): void {
    for (const file of this.host.getOpenFiles()) {
      if (!file || !this.registry.has(file.path)) {
        continue;
      }

      this.host.scheduleExternalCapture(file);
    }
  }

  /**
   * Reconstructs a serialized entry whose live file is missing as a tombstone.
   * A payload that already carries `deletedTimestamp` is rebuilt verbatim so
   * the original deletion moment survives a restart; a live payload whose file
   * is gone is auto-tombstoned with `deletedTimestamp = data.timestamp` (the
   * snapshot's last-known moment), keeping deleted-file history accessible
   * even when the delete happened while the plugin was off.
   *
   * @param {SerializedFileSnapshot} data - The serialized snapshot
   */
  protected restoreOrphan(data: SerializedFileSnapshot): void {
    const snapshot: FileSnapshot = SnapshotCodec.decode(data, null);

    if (!snapshot.isTombstone()) {
      snapshot.deletedTimestamp = data.timestamp;
    }

    /**
     * Detach the file reference: the underlying TFile no longer exists, so the
     * tombstone must not pretend to point at a live vault entry.
     */
    snapshot.file = null;

    this.registry.set(data.path, snapshot);
  }
}
