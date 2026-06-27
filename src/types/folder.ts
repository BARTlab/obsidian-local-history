import type { FolderDeltaStatus, FolderTimelinePointKind } from '@/consts';
import type { FunctionVoid, TranslationVars } from '@/types/ui';

/**
 * Callback fired when the user clicks a file row. The component passes the
 * vault-relative path so the parent modal can drive the diff pane.
 */
export type FolderTreeSelectionHandler = (path: string) => void;

/**
 * Internal tree node: a folder (possibly the synthetic root) or a leaf file.
 * Children of a folder are sorted alphabetically with folders before files so
 * the rendered output reads top-down like a file explorer.
 */
export interface FolderTreeNode {
  /** Vault-relative path of the node (folder or file). */
  path: string;
  /** Display name (the last path segment). */
  name: string;
  /** Whether this node is a folder; files are leaves. */
  isFolder: boolean;
  /** Per-file delta status; undefined for folder nodes. */
  status?: FolderDeltaStatus;
  /** Whether the file's delta point at T is an external-change capture. */
  external?: boolean;
  /** Child nodes (folders + files) when `isFolder` is true. */
  children: FolderTreeNode[];
}

/**
 * Toolbar button config used by the folder modal toolbar. Mirrors the shape the
 * file modal uses (icon id + accessible label + click handler) so both modals
 * present a consistent control surface. The `warning` flag adds the destructive
 * accent (`.lct-toolbar-warning`) for the restore-original and remove-history
 * actions, matching the file modal's classification.
 */
export interface FolderToolbarButtonConfig {
  /** The Obsidian (Lucide) icon id to render */
  icon: string;
  /** The text label exposed via tooltip and aria-label */
  label: string;
  /** The click handler */
  onClick: FunctionVoid;
  /** Whether to paint the destructive accent */
  warning?: boolean;
}

/**
 * Result of comparing a snapshot's state at a chosen timeline point T to its
 * current state. `base` is the resolved content at T (an empty array means
 * "did not exist at T"); `current` is the resolved live content (an empty array
 * means "does not exist now"); `status` is the categorical diff used by the
 * folder tree colouring.
 *
 * The two content arrays are returned as plain copies so the diff renderer can
 * consume them without worrying about mutating the underlying snapshot.
 */
export interface FolderDeltaResult {
  status: FolderDeltaStatus;
  base: string[];
  current: string[];
}

/**
 * A single point in the folder timeline. `timestamp` is the moment the event
 * happened (newest-first when sorted), `path` is the snapshot's vault-relative
 * path under the folder root, `kind` is the discriminator above, and `dayKey`
 * is the localized day string (`new Date(timestamp).toLocaleDateString()`) the
 * rail uses to group rows: identical to {@link FileVersion.getDate} so the
 * folder modal rail can group rows the same way the file modal rail does.
 *
 * For a `'capture'` point, `versionId` carries the originating version's id
 * so callers can correlate the timeline entry with the underlying
 * {@link FileVersion}. For `'delete'` and `'move-in'` points, the field stays
 * `undefined` (the event is a snapshot-level marker, not tied to a version).
 */
export interface FolderTimelinePoint {
  timestamp: number;
  path: string;
  kind: FolderTimelinePointKind;
  dayKey: string;
  versionId?: string;
}

/**
 * One entry handed to {@link FolderTreeComponent.update}: a vault-relative file
 * path and the per-file delta status resolved by `FolderDeltaHelper.compareAt`
 * for the selected timeline point T.
 *
 * The component only renders rows whose status is `added | modified | deleted`
 *. Entries with status `'none'` are accepted to keep the call-site simple
 * (the caller can pass every snapshot in the subtree) but are filtered out
 * before rendering so the tree shows only the files that actually changed.
 */
export interface FolderTreeEntry {
  path: string;
  status: FolderDeltaStatus;
  /**
   * Optional flag set when the file's latest delta point at the picked T is an
   * external-change capture. The component renders a small badge on
   * the file row when true so the user can spot external states without
   * leaving the tree (AC3). The field is optional so unit tests and earlier
   * callers can keep ignoring it; the rendered tree only depends on it for the
   * badge, not for the row's visibility or its status colour token.
   */
  external?: boolean;
}

/**
 * Minimal translator surface the component needs. Matches `LineChangeTrackerPlugin.t`
 * so the modal can pass `plugin` directly, but stays narrow so unit tests can
 * supply an inert translator (echoing keys) without the real plugin instance.
 */
export interface FolderTreeTranslator {
  t(key: string, vars?: TranslationVars): string;
}

/**
 * Parameters for {@link FolderTreeComponent.update}. The component fully owns
 * the DOM under its mount container, so update is the single entry point that
 * rebuilds the tree against a fresh `(entries, rootPath)` pair while keeping
 * the user's expand/collapse state and the currently-selected file (when it is
 * still present in the new entries).
 */
export interface FolderTreeUpdateParams {
  entries: FolderTreeEntry[];
  rootPath: string;
}
