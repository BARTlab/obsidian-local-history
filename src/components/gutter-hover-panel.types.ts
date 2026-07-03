/**
 * Host port the {@link GutterHoverPanel} reads its environment through. The
 * controller owns the panel element, its state machine, and every listener, but
 * stays decoupled from Obsidian and CodeMirror: it reads the feature gate, the
 * mount target, and the accessible label back through this port, so it unit
 * tests under jsdom with a plain fake host. The gutter extension implements it
 * from its injected settings and i18n services.
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
