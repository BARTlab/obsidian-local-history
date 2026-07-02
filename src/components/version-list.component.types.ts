import type LineChangeTrackerPlugin from '@/main';
import type { FileSnapshot } from '@/snapshots/file.snapshot';

/**
 * Host port the {@link VersionList} reads its shared modal state through. The
 * component owns the rail rendering and keyboard selection but stays stateless
 * about the modal: it reads the live selection, the search/filter flags, and
 * the timeline target back through this port, and reports a selection change
 * via {@link selectBase} so the host re-renders the rail and the active diff.
 */
export interface VersionListHost {
  /** The file snapshot whose versions the rail lists. */
  readonly snapshot: FileSnapshot;

  /** The plugin instance, used only for translation lookups. */
  readonly plugin: LineChangeTrackerPlugin;

  /**
   * Container element holding the version timeline list, or `undefined` in
   * rail-less mode (the panel's hideRail open option). The component is a no-op
   * when it is absent.
   *
   * @return {HTMLElement | undefined} The rail container, or undefined
   */
  versionsEl(): HTMLElement | undefined;

  /**
   * The id of the currently selected diff base, used to mark the active row and
   * as the cursor the keyboard selection walks from.
   *
   * @return {string} The selected base id
   */
  selectedBaseId(): string;

  /**
   * The current content-search query for the rail. An empty string shows every
   * version.
   *
   * @return {string} The search query
   */
  searchQuery(): string;

  /**
   * Whether the rail hides versions whose captured content equals the current
   * state.
   *
   * @return {boolean} True when identical versions are hidden
   */
  hideIdenticalVersions(): boolean;

  /**
   * The optional selection filter ids: when present the rail only
   * shows versions in the set, or collapses to its no-results hint on an empty
   * set. `undefined` disables the filter.
   *
   * @return {ReadonlySet<string> | undefined} The selection filter ids, or undefined
   */
  selectionFilterIds(): ReadonlySet<string> | undefined;

  /**
   * Selects a new diff base. The host updates its selected base, re-renders the
   * rail, and refreshes the active diff. A no-op on the host side when the base
   * is already selected.
   *
   * @param {string} id - The base id to select
   */
  selectBase(id: string): void;
}

/** Internal rail entry shape: one selectable row's denormalised display data. */
export type RailEntry = {
  /** The base id this row selects. */
  id: string;
  /** The primary label (custom label or derived action text). */
  label: string;
  /** The capture day used to group rows under a heading. */
  day: string;
  /** The capture date+time shown as secondary metadata on the row. */
  meta: string;
  /** The formatted line delta, or an empty string for a no-op capture. */
  delta: string;
  /** Whether the version was captured from an external change (renders a badge). */
  external: boolean;
};
