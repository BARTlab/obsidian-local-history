import * as TextHelper from '@/helpers/text.helper';
import type { ExternalChangeHost } from '@/snapshots/external-change-capture.types';
import type { FileSnapshot } from '@/snapshots/file.snapshot';
import type { FileVersion } from '@/snapshots/file.version';
import type { TFile } from 'obsidian';

/**
 * Plain collaborator that owns the external (off-editor) change detection
 * concern of {@link SnapshotsService}: the per-path debounce that coalesces a
 * burst of `vault.modify` events, the in-flight guard against concurrent
 * captures, the stat-based last-seen pre-check, and the disk-read + hash-compare
 * capture flow that lands a distinct external state as a flagged
 * {@link FileVersion}.
 *
 * It is instantiated and owned by the service (not a DI service), so the DI
 * container's `constructor.name` resolution and registration ordering are
 * untouched. It reads the snapshot map and gating through a narrow
 * {@link ExternalChangeHost} port and routes first-sight captures and the
 * post-capture forced update back through it, keeping the service the sole
 * owner of snapshot CRUD.
 */
export class ExternalChangeCapture {
  /**
   * Window (ms) that coalesces a burst of vault.modify events per file before
   * the disk read + hash runs. Picked to be shorter than a typical human edit
   * cadence (so a real follow-up captures promptly) but long enough that a
   * sync/git storm's repeated writes for one file collapse into one capture.
   */
  protected static readonly debounceMs: number = 150;

  /**
   * Per-path debounce timers for `capture`. A new modify event for the same
   * path resets the timer; only the trailing call runs the disk read and
   * capture.
   */
  protected debounceTimers: Map<string, number> = new Map();

  /**
   * Per-path in-flight guard for `capture`. Holds the path of any file
   * currently in the middle of a disk read + capture, so a follow-up modify
   * event that fires before the prior call resolves does not start a second
   * concurrent read of the same file and double-capture the same state.
   */
  protected inFlight: Set<string> = new Set();

  /**
   * Last-seen `stat.mtime` + `stat.size` per tracked path, captured at the end
   * of every `capture` call (success or hash-match no-op). A follow-up modify
   * whose stat values match these is short-circuited before the disk read:
   * nothing on disk could have changed since the last pass, so reading +
   * hashing would just burn IO. Cleared on `forget`/`clear`.
   */
  protected lastSeen: Map<string, { mtime: number; size: number }> = new Map();

  /**
   * Creates a new ExternalChangeCapture bound to its owning service's host port.
   *
   * @param {ExternalChangeHost} host - The narrow port onto the snapshot state
   */
  public constructor(
    protected host: ExternalChangeHost,
  ) {
  }

  /**
   * Public entry point for the vault.modify handler. Coalesces a burst of
   * modify events for the same path through a per-path debounce, then runs
   * `capture` once with an in-flight guard so an overlapping follow-up modify
   * cannot double-capture the same disk state.
   *
   * Bursts of writes (sync, git pull, an external save loop) for one file
   * collapse into a single trailing capture; events for different files run
   * independently. The stat-based short-circuit inside `capture` skips the disk
   * read when nothing about the file's mtime/size changed between this debounced
   * call and the previous one.
   *
   * @param {TFile} file - The file whose modify event fired
   */
  public schedule(file: TFile): void {
    if (!file) {
      return;
    }

    const path: string = file.path;
    const existing: number | undefined = this.debounceTimers.get(path);

    if (existing !== undefined) {
      window.clearTimeout(existing);
    }

    const timer: number = window.setTimeout((): void => {
      this.debounceTimers.delete(path);
      void this.runGuarded(file);
    }, ExternalChangeCapture.debounceMs);

    this.debounceTimers.set(path, timer);
  }

  /**
   * Captures an external (off-editor) change to a tracked file as a flagged
   * version on its timeline. Reads the file from disk, compares the
   * actual content to the snapshot's known `state` via `isContentChanged`
   * (32-bit hash as a cheap pre-filter, line-by-line compare on a hash match
   * so a collision cannot mask a real rewrite), and force-captures
   * the new content as a `FileVersion` with `external = true` only when they
   * differ, then updates `state`/tracker/changes so further reads see the
   * captured content as the new baseline.
   *
   * Gating mirrors the parts of `canCapture` that still apply when a snapshot
   * already exists: a wrong-extension file, an excluded path, an ignored file,
   * or a missing/folder TFile is a no-op. A content match is also a no-op so
   * editor-driven flushes and the plugin's own revert writes (which already
   * synchronized `state` before/after the write) do not produce phantom
   * external versions.
   *
   * A first-sight file (no snapshot yet) is captured as a normal snapshot via
   * the host, without an `external` version: there is no prior state to diff
   * against, so flagging the very first capture would mislabel a brand-new
   * file as an external change.
   *
   * A tombstone entry is a no-op: a tombstone represents a deleted file at
   * that path and `vault.modify` should not legitimately fire there; the
   * resurrection flow belongs to a future `vault.create` handler, not here.
   *
   * The capture is forced past the cadence gates so every distinct external
   * state lands as its own version, but it is NOT pinned: the resulting
   * version obeys the normal age/count retention exactly like a cadence one,
   * so a chatty sync workflow cannot bloat `history.json` with un-evictable
   * entries.
   *
   * @param {TFile | null} file - The file whose disk content changed
   */
  public async capture(file?: TFile | null): Promise<void> {
    if (!file) {
      return;
    }

    if (!this.host.isExternallyCapturable(file)) {
      return;
    }

    const snapshot: FileSnapshot | undefined = this.host.getSnapshot(file.path);

    if (!snapshot) {
      await this.host.captureFirstSight(file);
      this.rememberLastSeen(file);

      return;
    }

    /**
     * A tombstone at this path means our model thinks the file is gone; a
     * legitimate modify should never reach this point, and a resurrection is
     * not an "external change" semantically. Leave the tombstone alone so the
     * history modal still surfaces the file's last-known state.
     */
    if (snapshot.isTombstone()) {
      return;
    }

    /**
     * Stat pre-check: if mtime and size match the last-seen values
     * for this path, nothing on disk could have changed since the previous
     * pass, so skip the disk read entirely. The very first pass (no entry)
     * always falls through to the read.
     */
    const lastSeen: { mtime: number; size: number } | undefined = this.lastSeen.get(file.path);
    const currentStat: { mtime: number; size: number } | undefined = this.getFileStat(file);

    if (lastSeen && currentStat
      && lastSeen.mtime === currentStat.mtime
      && lastSeen.size === currentStat.size
    ) {
      return;
    }

    let content: string;

    try {
      content = await this.host.plugin.app.vault.read(file);
    } catch (error) {
      console.error('Error reading file for external change capture:', error);

      return;
    }

    /**
     * Content-equality guard: the 32-bit `lastHash` is only a cheap
     * pre-filter inside `isContentChanged`; on a hash match it falls through
     * to a line-by-line compare against the snapshot's known `state`, so a
     * collision cannot mask a genuine external rewrite as a no-op.
     */
    if (!snapshot.isContentChanged(content)) {
      this.rememberLastSeen(file);

      return;
    }

    // Split on `/\r?\n/` so fresh disk content decomposes into the same lines the
    // tracker and editor hold; a mixed-ending file must not merge lines the change
    // model keeps separate, which would desync the per-line diff below.
    const newLines: string[] = TextHelper.splitLines(content);
    const captured: FileVersion | null = snapshot.captureVersion(newLines, this.host.getCaptureOptions(), true);

    if (captured) {
      /**
       * The version captures the NEW disk content as a discrete point on the
       * timeline (every distinct external state lands as its own version).
       * Setting the flag after capture keeps file.snapshot.ts free of an
       * external-aware overload and still flows through the normal eviction
       * pipeline, so external versions remain evictable like cadence ones.
       */
      captured.external = true;
    }

    /**
     * Bring the tracker in line with the new content as a minimal per-hunk
     * update, then refresh the cached state and change map. Without this, the
     * tracker would still describe the pre-change content and the gutter
     * markers would drift out of sync with what the user sees in the editor.
     * Rewriting the whole current span as one block instead would destroy and
     * re-add the tracker of every line, so a model that lags the editor by a
     * single skipped update (the disk write is the editor's own auto-save)
     * would repaint the entire note as added after one inserted line.
     */
    this.applyLineDiff(snapshot, snapshot.content.state, newLines);
    snapshot.content.updateState(newLines);
    snapshot.updateChanges();

    /**
     * A forced external capture pushes a version and may evict the oldest, sliding
     * the keep=persist origin. Re-seed the change map against the new origin now,
     * before the forced update, so the gutter and tree reflect the retention-bounded
     * origin without waiting for the next in-editor edit. A no-op when nothing was
     * captured, at keep=file/app, or when the oldest version is unchanged.
     */
    if (captured) {
      this.host.reseedOriginIfSlid(snapshot);
    }

    this.host.forceUpdate();
    this.rememberLastSeen(file);
  }

  /**
   * Drops any per-path debounce timer, in-flight marker, and last-seen stat
   * for the given path. Called when a snapshot is removed/renamed/moved so
   * stale state for a now-absent or relocated path cannot leak into a future
   * modify event.
   *
   * @param {string} path - The vault-relative path to forget
   */
  public forget(path: string): void {
    const timer: number | undefined = this.debounceTimers.get(path);

    if (timer !== undefined) {
      window.clearTimeout(timer);
      this.debounceTimers.delete(path);
    }

    this.inFlight.delete(path);
    this.lastSeen.delete(path);
  }

  /**
   * Clears every pending debounce timer, the in-flight guard, and the last-seen
   * stat baseline. Called from the service's `clear`/`wipe` so a full reset
   * leaves no stray timer firing against a wiped snapshot map.
   */
  public clear(): void {
    for (const timer of this.debounceTimers.values()) {
      window.clearTimeout(timer);
    }

    this.debounceTimers.clear();
    this.inFlight.clear();
    this.lastSeen.clear();
  }

  /**
   * Runs `capture` under a per-path in-flight guard so a second debounced
   * trigger that fires while the first is still awaiting the disk read cannot
   * start a second concurrent capture for the same path. If a follow-up trigger
   * arrives during the capture, the path's scheduler hands off to a re-schedule
   * after the in-flight call resolves so the most recent disk state is never
   * silently dropped (the trailing write of a sync storm still lands as a
   * version).
   *
   * The guard is released in a `finally` so an error inside the capture never
   * strands the path as permanently in-flight.
   *
   * @param {TFile} file - The file to capture
   */
  protected async runGuarded(file: TFile): Promise<void> {
    const path: string = file.path;

    if (this.inFlight.has(path)) {
      /**
       * A capture is already in flight; re-schedule via the debounce so the
       * follow-up call coalesces into one trailing pass after the current
       * one resolves rather than silently dropping the latest write.
       */
      this.schedule(file);

      return;
    }

    this.inFlight.add(path);

    try {
      await this.capture(file);
    } finally {
      this.inFlight.delete(path);
    }
  }

  /**
   * Applies the divergence between the model's known lines and the disk lines
   * as a minimal per-hunk tracker update: untouched lines keep their trackers
   * (and markers), a same-count hunk edits its lines in place, and only
   * genuinely new or destroyed lines are added or removed.
   *
   * Hunks are applied bottom-up so the current-position coordinates of the
   * earlier hunks stay valid while the later ones shift the tracker index,
   * mirroring the reverse iteration of the change detector.
   *
   * @param {FileSnapshot} snapshot - The snapshot whose tracker to resync
   * @param {string[]} previous - The model's known state lines
   * @param {string[]} next - The disk content lines to converge onto
   */
  protected applyLineDiff(snapshot: FileSnapshot, previous: string[], next: string[]): void {
    snapshot.trackers.reconcile(previous, next);
  }

  /**
   * Reads the file's current `stat.mtime` / `stat.size` without throwing if
   * the stat block is missing (older Obsidian builds, test stubs). Returns
   * undefined when the stat is unusable so the caller falls through to a
   * normal disk read instead of incorrectly short-circuiting.
   *
   * @param {TFile} file - The file to read stat from
   * @return {{mtime: number, size: number} | undefined} The stat values or undefined
   */
  protected getFileStat(file: TFile): { mtime: number; size: number } | undefined {
    const stat: { mtime?: number; size?: number } | undefined = file?.stat;

    if (!stat || typeof stat.mtime !== 'number' || typeof stat.size !== 'number') {
      return undefined;
    }

    return { mtime: stat.mtime, size: stat.size };
  }

  /**
   * Stores the file's current mtime/size as the last-seen baseline for the
   * stat pre-check. Called after a successful capture, after a hash-match
   * no-op, and after a first-sight capture so the next modify event for the
   * same path can skip the disk read when nothing changed.
   *
   * @param {TFile} file - The file whose stat to remember
   */
  protected rememberLastSeen(file: TFile): void {
    const stat: { mtime: number; size: number } | undefined = this.getFileStat(file);

    if (!stat) {
      return;
    }

    this.lastSeen.set(file.path, stat);
  }
}
