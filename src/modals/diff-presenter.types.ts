import type { DiffHeaderController } from '@/modals/diff-header-controller';
import type { DiffScrollSync } from '@/modals/diff-scroll-sync';
import type { DiffViewState } from '@/modals/diff-view-state';
import type { GutterRevertHandler } from '@/modals/gutter-revert-handler';
import type LineChangeTrackerPlugin from '@/main';
import type { FileSnapshot } from '@/snapshots/file.snapshot';
import type { FileVersion } from '@/snapshots/file.version';
import type { HTMLElementWithScrollSync } from '@/types';

/**
 * Host port the {@link DiffPresenter} reads its shared modal state and
 * collaborators through. The presenter owns the diff-render pipeline but stays
 * stateless about the modal: it reads the live diff container back through this
 * port, drives the modal's owned collaborators (view state, scroll sync, gutter
 * reverts, diff header) held here as refs, resolves the base label through the
 * version list, and reports the base-vs-current fact so the modal can sync its
 * toolbar action buttons.
 */
export interface DiffPresenterHost {
  /** The file snapshot whose content the diff renders. */
  readonly snapshot: FileSnapshot;

  /** The plugin instance, used for translation lookups. */
  readonly plugin: LineChangeTrackerPlugin;

  /** The diff-view state (selected base, display mode, hunk focus, button registries). */
  readonly viewState: DiffViewState;

  /** The side-by-side scroll-synchronisation collaborator. */
  readonly scrollSync: DiffScrollSync;

  /** The per-hunk inline revert collaborator. */
  readonly gutterReverts: GutterRevertHandler;

  /** The shared notice / columns-header controller. */
  readonly diffHeader: DiffHeaderController;

  /**
   * The rendered diff container, or `undefined` before the first render. The
   * render is a no-op DOM-wise when it is absent.
   *
   * @return {HTMLElementWithScrollSync | undefined} The diff container, or undefined
   */
  diffContainer(): HTMLElementWithScrollSync | undefined;

  /**
   * Resolves the rail-matching primary label for a picked version, used to
   * label the base (left) side of the side-by-side columns header.
   *
   * @param {FileVersion} version - The picked base version
   * @param {FileVersion[]} versions - The full version list, newest first
   * @return {string} The primary label for that version
   */
  resolvePrimaryLabel(version: FileVersion, versions: FileVersion[]): string;

  /**
   * Syncs the restore/remove/label toolbar action buttons for the current base.
   * The presenter passes whether the selected base already equals the current
   * state (nothing to restore); the modal owns which buttons to disable.
   *
   * @param {boolean} baseIsCurrent - Whether the base equals the current state
   */
  syncActionButtons(baseIsCurrent: boolean): void;
}
