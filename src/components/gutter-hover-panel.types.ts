import type * as Diff from 'diff';

/**
 * Which of the three marker states the panel is rendering. Drives a content
 * modifier class and the copy affordance: `changed` shows the previous version
 * of the line(s) with word-level old-vs-new spans, `added` shows the newly
 * inserted content (there is no previous version, so it carries no old text),
 * and `removed` shows the deleted base line(s).
 */
export enum GutterHoverPanelContentKind {
  changed = 'changed',
  added = 'added',
  removed = 'removed',
}

/**
 * One word-level segment of a rendered content line: its text plus whether it
 * was added or removed relative to the other side. A segment that is neither is
 * unchanged context. Mirrors the diff library's per-word change without leaking
 * that type across the port, so the controller stays a plain view.
 */
export interface GutterHoverPanelSegment {
  /** The segment text. */
  text: string;
  /** True when the words are present only in the new (current) side. */
  added: boolean;
  /** True when the words are present only in the old (base) side. */
  removed: boolean;
}

/**
 * The display model the controller renders for a hovered line: the marker state
 * and the content as word-segmented lines. The lines carry old-vs-new spans for
 * a change, the new content for a pure addition, and the deleted base lines for
 * a removal. The controller is a pure view over this; the host resolves it.
 */
export interface GutterHoverPanelContent {
  /** The marker state, used for a content modifier class. */
  kind: GutterHoverPanelContentKind;
  /** The content lines, each a list of word segments, top to bottom. */
  lines: GutterHoverPanelSegment[][];
  /**
   * True when the change carries no visible text on either side (a blank or
   * whitespace-only line). The controller then renders a muted placeholder
   * instead of an empty tinted block and disables copy, since there is nothing
   * meaningful to copy.
   */
  blank: boolean;
}

/**
 * The full resolution of a hovered line: the display {@link GutterHoverPanelContent},
 * the covering hunk (the revert applies exactly this block), and the hunk's
 * base-side text (the copy writes exactly this). Returned by the pure resolver
 * and consumed by the host, which owns the Obsidian-side effects; the controller
 * only ever sees the {@link GutterHoverPanelContent}.
 */
export interface GutterHoverPanelResolution {
  /** The display model. */
  content: GutterHoverPanelContent;
  /** The resolved hunk, the same block the gutter revert resolves at that line. */
  hunk: Diff.StructuredPatchHunk;
  /** The hunk's base-side text, the exact payload the copy action writes. */
  baseText: string;
}

/**
 * The localized accessible labels for the three action buttons, read back
 * through the host so the controller stays free of the i18n service.
 */
export interface GutterHoverPanelActionLabels {
  /** Label for the revert-this-change button. */
  revert: string;
  /** Label for the copy-old-text button. */
  copy: string;
  /** Label for the open-history button. */
  history: string;
}

/**
 * Host port the {@link GutterHoverPanel} reads its environment through. The
 * controller owns the panel element, its state machine, and every listener, but
 * stays decoupled from Obsidian and CodeMirror: it reads the feature gate, the
 * mount target, the accessible label, the resolved content model, and the action
 * side effects back through this port, so it unit tests under jsdom with a plain
 * fake host. The gutter extension implements it from its injected snapshot,
 * modals, settings, and i18n services.
 */
export interface GutterHoverPanelHost {
  /**
   * Whether the hover panel feature is enabled (the `gutterHoverPanel` setting).
   * Read on every hover so a disabled feature never mounts a panel.
   *
   * @return {boolean} True when the panel may open
   */
  isEnabled(): boolean;

  /**
   * The element the panel is appended to (the editor container or document
   * body). The panel positions itself with `position: fixed` in viewport
   * coordinates, so the container only needs to be a stable, unclipped parent.
   *
   * @return {HTMLElement} The mount target
   */
  getContainer(): HTMLElement;

  /**
   * The localized accessible name for the panel's `dialog` role.
   *
   * @return {string} The aria-label text
   */
  ariaLabel(): string;

  /**
   * Resolves the display model for a hovered line, or null when the line maps to
   * no change block. Read on mount and whenever the panel re-anchors to another
   * marker.
   *
   * @param {number} line - The 0-based line the panel is anchored to
   * @return {GutterHoverPanelContent | null} The content model, or null
   */
  resolveContent(line: number): GutterHoverPanelContent | null;

  /**
   * The localized accessible labels for the panel's action buttons.
   *
   * @return {GutterHoverPanelActionLabels} The three button labels
   */
  actionLabels(): GutterHoverPanelActionLabels;

  /**
   * The localized placeholder shown in place of the content when the hovered
   * change carries no visible text (a blank or whitespace-only line), so the
   * panel never renders an empty tinted block.
   *
   * @return {string} The placeholder text
   */
  emptyLabel(): string;

  /**
   * Sets a Lucide icon on an action button, kept on the host so the controller
   * never imports Obsidian's `setIcon`.
   *
   * @param {HTMLElement} element - The button to decorate
   * @param {string} icon - The Lucide icon id
   */
  applyIcon(element: HTMLElement, icon: string): void;

  /**
   * Reverts the change block at the given line back to the base, confirming
   * first. Resolves once the confirm is answered (accept or cancel) so the
   * controller can close the panel after it settles.
   *
   * @param {number} line - The 0-based line whose block is reverted
   * @return {Promise<void>} Resolves when the confirm has been answered
   */
  revert(line: number): Promise<void>;

  /**
   * Writes the base-side text of the change block at the given line to the
   * clipboard and confirms with a notice. The panel stays open after a copy.
   *
   * @param {number} line - The 0-based line whose old text is copied
   */
  copyOldText(line: number): void;

  /**
   * Opens the file history for the active file. The panel closes after.
   */
  openHistory(): void;
}

/**
 * The hover-intent delays owned by the controller, in milliseconds. `openDelayMs`
 * is the dwell before a hovered marker opens the panel; `closeDelayMs` is the
 * grace after the pointer leaves both marker and panel, which doubles as the
 * hover bridge across the gap between them.
 */
export interface GutterHoverPanelTimings {
  /** Dwell before a hovered marker opens the panel. */
  openDelayMs: number;
  /** Grace after the pointer leaves both marker and panel before it unmounts. */
  closeDelayMs: number;
}

/**
 * The controller's lifecycle states. `pending` is the open-delay dwell, `closing`
 * is the close-delay grace (the hover bridge window); both `closed` and the two
 * transient states are observable via {@link GutterHoverPanel.getState} so the
 * state machine is assertable in tests.
 */
export enum GutterHoverPanelState {
  closed = 'closed',
  pending = 'pending',
  open = 'open',
  closing = 'closing',
}
