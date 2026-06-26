import type { DiffOutputFormatType, DiffViewMode } from '@/consts';
import type { FunctionVoid, TranslationVars } from '@/types/ui';

/**
 * Configuration object for ConfirmModal parameters.
 * All parameters are optional with sensible defaults.
 */
export interface ConfirmModalConfig {
  /**
   * The title of the confirmation dialog
   */
  title?: string;
  /**
   * The message content of the confirmation dialog
   */
  message?: string;
  /**
   * Text for the confirmation button (defaults to 'Confirm')
   */
  confirmText?: string;
  /**
   * Text for the cancel button (defaults to 'Cancel')
   */
  cancelText?: string;
}

/**
 * Configuration object for PromptModal parameters. A prompt asks the user for a
 * single short string (for example a custom version label) and resolves to the
 * entered text or null on cancel. All fields are optional with sensible
 * defaults so a caller can open a minimal prompt by passing an empty config.
 */
export interface PromptModalConfig {
  /**
   * The title of the prompt dialog
   */
  title?: string;
  /**
   * Optional message rendered above the input
   */
  message?: string;
  /**
   * Placeholder text shown inside the empty input
   */
  placeholder?: string;
  /**
   * Initial value pre-filled in the input
   */
  initialValue?: string;
  /**
   * Text for the confirm button (defaults to 'Confirm')
   */
  confirmText?: string;
  /**
   * Text for the cancel button (defaults to 'Cancel')
   */
  cancelText?: string;
}

/**
 * Shape of a single toolbar icon button: the Lucide icon id, the label exposed
 * via tooltip and aria-label, the click handler (sync or async), and an
 * optional destructive accent for the restore-original and remove-history
 * actions.
 */
export interface ToolbarButtonConfig {
  /**
   * The Obsidian (Lucide) icon id to render
   */
  icon: string;
  /**
   * The text label exposed via tooltip and aria-label
   */
  label: string;
  /**
   * The click handler, awaited when it returns a promise
   */
  onClick: FunctionVoid | (() => Promise<void>);
  /**
   * Whether to add the destructive (error-tinted) accent
   */
  warning?: boolean;
}

/**
 * The four supported diff display modes. The two {@link DiffViewMode} values
 * render the textual unified patch and the word-level inline highlights, and
 * the two {@link DiffOutputFormatType} values render the diff2html line-by-line
 * or side-by-side views.
 */
export type DiffRenderMode = DiffViewMode | DiffOutputFormatType;

/**
 * Minimal translator surface the helper needs. Matches `LineChangeTrackerPlugin.t`
 * so the modal can pass `plugin` directly, but stays narrow so a test or another
 * caller can provide its own translator without dragging in the whole plugin.
 */
interface DiffRenderTranslator {
  t(key: string, vars?: TranslationVars): string;
}

/**
 * Parameters accepted by {@link DiffRenderHelper.render}. The renderer is pure
 * and modal-agnostic: it owns no state, holds no references, and only mutates
 * the provided container. Per-hunk revert affordances, the columns header,
 * the diff notice, and scroll synchronization stay in the calling modal because
 * they are file-mode specific.
 */
export interface DiffRenderParams {
  /**
   * The selected base content split by `lineBreak`.
   */
  baseLines: string[];
  /**
   * The current state content split by `lineBreak`.
   */
  currentLines: string[];
  /**
   * The line separator used when joining content back into text for patches.
   */
  lineBreak: string;
  /**
   * Which of the four diff modes to render.
   */
  mode: DiffRenderMode;
  /**
   * The container the renderer writes the diff DOM into.
   */
  container: HTMLElement;
  /**
   * The vault-relative file path used in the unified patch headers.
   */
  filePath: string;
  /**
   * Translator used for the copy button tooltip and the copy notice text.
   */
  plugin: DiffRenderTranslator;
}

/**
 * Open options for the history/diff modal. Both fields are optional, so a call
 * with no options preserves the current default behaviour: the rail is shown
 * and the modal opens on the latest captured version.
 *
 * - `initialBaseId`: pre-selects a specific version id as the diff base on open
 *   (the rail entry that would otherwise be the top one). A baseline-only file
 *   ignores it; an unknown id falls through to the modal's default selection.
 * - `hideRail`: opens the modal without the left rail (search + version list),
 *   so the diff and the toolbar fill the modal. Used by the Recent changes
 *   panel, which is the navigator in that session.
 */
export interface HistoryModalOpenOptions {
  /**
   * The version id to pre-select as the diff base on open.
   */
  initialBaseId?: string;
  /**
   * Whether to hide the left rail (search + version list).
   */
  hideRail?: boolean;
  /**
   * Optional set of version ids the rail must restrict itself to: when present,
   * only versions whose id is in the set survive the rail filters. Used by
   * "Show History for Selection" to narrow the rail to versions where
   * the editor selection was added or removed. `undefined` means no selection
   * filter is active (the rail behaves as before); an empty set means a filter
   * is active but matched nothing, so the rail shows its no-results hint.
   */
  selectionFilterIds?: ReadonlySet<string>;
}
