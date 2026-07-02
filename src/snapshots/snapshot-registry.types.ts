/**
 * Host port the {@link SnapshotRegistry} reads its two outside dependencies
 * through. The registry owns the path-keyed snapshot map and the session-created
 * path set, but stays free of the plugin and its sibling collaborators: it asks
 * the host for the active editor's line break when creating a snapshot and
 * routes the "forget this path" signal to the external-capture collaborator when
 * a path is removed or renamed, so {@link SnapshotsService} keeps sole ownership
 * of the plugin handle and the collaborator wiring.
 */
export interface SnapshotRegistryHost {
  /**
   * The line ending of the active editor view, when one is open. Preferred over
   * sniffing the raw content so a freshly captured snapshot matches the editor
   * the user is looking at; undefined when no editor view is active, in which
   * case the registry falls back to detecting the ending from the content.
   *
   * @return {string | undefined} The active editor line break, or undefined
   */
  getActiveEditorLineBreak(): string | undefined;

  /**
   * Drops the external-capture debounce/in-flight/last-seen state for a path
   * that was just removed or renamed, so stale state for a now-absent or
   * relocated path cannot leak into a future modify event. Routed through the
   * host so the registry stays decoupled from the external-capture collaborator.
   *
   * @param {string} path - The vault-relative path to forget
   */
  forgetExternalCapture(path: string): void;
}
