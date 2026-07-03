import type {
  GutterHoverPanelHost,
  GutterHoverPanelTimings,
} from '@/components/gutter-hover-panel.types';
import { GutterHoverPanelState } from '@/components/gutter-hover-panel.types';
import type { FunctionVoid } from '@/types';

/**
 * Hand-rolled anchored panel that appears next to a hovered gutter bar marker
 * after a short dwell and disappears predictably (ADR D-001: a controller-owned
 * absolutely-positioned div, not an Obsidian `HoverPopover` or `Menu`). This is
 * the shell only: it owns the open/close state machine, the viewport-clamped
 * positioning, and every listener and timer, mounting an empty content slot that
 * a later task fills with the old line and its actions.
 *
 * State machine: `closed -> pending(open delay) -> open -> closing(close delay)
 * -> closed`. The pointer moving from the marker into the panel keeps it open
 * (the close delay is the hover bridge across the gap); leaving both starts the
 * close delay; re-entering cancels it. Every listener is added on mount and
 * removed on unmount through {@link cleanups}, so no listener or timer leaks past
 * a dismissal (the add/remove disposer pattern of `DiffScrollSync`).
 *
 * A plain collaborator the gutter extension owns, decoupled from Obsidian and
 * CodeMirror through {@link GutterHoverPanelHost} so it unit tests under jsdom.
 */
export class GutterHoverPanel {
  /** Gap (px) between the gutter marker and the panel, and viewport margin. */
  protected static readonly GAP_PX: number = 8;

  /** Current lifecycle state; drives the transition guards and is test-visible. */
  protected state: GutterHoverPanelState = GutterHoverPanelState.closed;

  /** The mounted panel element, or null while closed/pending. */
  protected panel: HTMLElement | null = null;

  /** The gutter element the panel is anchored to, captured at hover. */
  protected anchor: HTMLElement | null = null;

  /** The 0-based line the anchored marker sits on (-1 when closed). */
  protected line: number = -1;

  /** The editor scroller listened to for the scroll-dismiss, resolved on mount. */
  protected scrollTarget: HTMLElement | null = null;

  /** Pending open-delay timer, or null when no open is scheduled. */
  protected openTimer: ReturnType<typeof setTimeout> | null = null;

  /** Pending close-delay timer, or null when no close is scheduled. */
  protected closeTimer: ReturnType<typeof setTimeout> | null = null;

  /** Listener removers registered on mount, run once on unmount. */
  protected cleanups: FunctionVoid[] = [];

  /** True after {@link destroy}, so a late hover cannot resurrect the panel. */
  protected destroyed: boolean = false;

  /**
   * @param {GutterHoverPanelHost} host - Environment port (gate, mount target, label).
   * @param {GutterHoverPanelTimings} timings - Open/close delays; defaults sit in
   *   the 150-300 ms dwell / ~200 ms grace band the design specifies.
   */
  public constructor(
    protected readonly host: GutterHoverPanelHost,
    protected readonly timings: GutterHoverPanelTimings = { openDelayMs: 200, closeDelayMs: 200 },
  ) {
  }

  /**
   * The current lifecycle state, so tests can assert the machine directly.
   *
   * @return {GutterHoverPanelState} The current state
   */
  public getState(): GutterHoverPanelState {
    return this.state;
  }

  /**
   * The 0-based line the anchored marker sits on, or -1 while closed. Confirms
   * the hovered line reached the controller; the content task reads it to look
   * up the previous version of that line.
   *
   * @return {number} The anchored 0-based line, or -1
   */
  public getLine(): number {
    return this.line;
  }

  /**
   * Hover intent over a marker: schedules the open after the dwell, or re-anchors
   * an already-open panel to the new marker (never a second panel). A disabled
   * feature or a destroyed controller is a no-op, so no panel is ever created
   * while the setting is off.
   *
   * @param {number} line - The 0-based line of the hovered marker
   * @param {HTMLElement} anchor - The gutter element to position against
   */
  public enter(line: number, anchor: HTMLElement): void {
    if (this.destroyed || !this.host.isEnabled()) {
      return;
    }

    // Re-entering from a close grace or moving between markers cancels the close.
    this.clearCloseTimer();

    if (this.state === GutterHoverPanelState.open || this.state === GutterHoverPanelState.closing) {
      this.state = GutterHoverPanelState.open;
      this.line = line;

      if (anchor !== this.anchor) {
        this.anchor = anchor;
        this.reposition();
      }

      return;
    }

    // Closed or already pending: retarget to the current marker and (re)arm the
    // single open timer so a sweep across markers still opens at the last one.
    this.anchor = anchor;
    this.line = line;

    if (this.state === GutterHoverPanelState.pending) {
      return;
    }

    this.state = GutterHoverPanelState.pending;
    this.openTimer = setTimeout((): void => this.mount(), this.timings.openDelayMs);
  }

  /**
   * The pointer left the marker. Before the dwell elapses this cancels the
   * pending open (no panel is created); while open it starts the close grace,
   * which a move into the panel or back onto the marker cancels.
   */
  public leave(): void {
    if (this.state === GutterHoverPanelState.pending) {
      this.clearOpenTimer();
      this.reset();

      return;
    }

    if (this.state === GutterHoverPanelState.open) {
      this.state = GutterHoverPanelState.closing;
      this.closeTimer = setTimeout((): void => this.unmount(), this.timings.closeDelayMs);
    }
  }

  /**
   * Closes the panel immediately, cancelling any pending open or close. This is
   * the entry point for every non-pointer dismissal the host drives: a document
   * change, an active-leaf change, or the feature being switched off.
   */
  public dismiss(): void {
    this.clearOpenTimer();

    if (this.panel) {
      this.unmount();

      return;
    }

    this.reset();
  }

  /**
   * Tears the controller down for good: dismisses any open panel and blocks
   * further opens. Idempotent, so it is safe to wire to both view teardown and
   * plugin unload.
   */
  public destroy(): void {
    this.destroyed = true;
    this.dismiss();
  }

  /**
   * Mounts the panel once the open dwell elapses: builds the element with its
   * `dialog` role and empty content slot, appends it to the host container,
   * wires the hover-bridge and dismissal listeners, and positions it.
   */
  protected mount(): void {
    this.openTimer = null;

    // A dismissal between arming and firing the timer clears the anchor.
    if (!this.anchor || this.destroyed) {
      this.reset();

      return;
    }

    const panel: HTMLElement = document.createElement('div');

    panel.className = 'lct-hover-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', this.host.ariaLabel());

    // Empty content slot: a later task renders the old line and actions here.
    const content: HTMLElement = document.createElement('div');

    content.className = 'lct-hover-panel-content';
    panel.appendChild(content);

    this.host.getContainer().appendChild(panel);
    this.panel = panel;
    this.state = GutterHoverPanelState.open;

    this.wireListeners(panel);
    this.reposition();
  }

  /**
   * Adds the panel-scoped listeners and records their removers so unmount can run
   * them: the hover bridge (pointer into the panel keeps it open, out of it
   * starts the close grace), Escape, and editor scroll.
   *
   * @param {HTMLElement} panel - The freshly mounted panel element
   */
  protected wireListeners(panel: HTMLElement): void {
    const onPanelEnter: FunctionVoid = (): void => {
      this.clearCloseTimer();
      this.state = GutterHoverPanelState.open;
    };

    const onPanelLeave: FunctionVoid = (): void => this.leave();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        this.dismiss();
      }
    };

    const onScroll: FunctionVoid = (): void => this.dismiss();

    panel.addEventListener('mouseenter', onPanelEnter);
    panel.addEventListener('mouseleave', onPanelLeave);
    document.addEventListener('keydown', onKeyDown);
    this.cleanups.push((): void => {
      panel.removeEventListener('mouseenter', onPanelEnter);
      panel.removeEventListener('mouseleave', onPanelLeave);
      document.removeEventListener('keydown', onKeyDown);
    });

    // Any scroll of the editor viewport dislodges the anchor, so dismiss on it.
    // Resolved from the anchor to stay free of the EditorView reference.
    this.scrollTarget = this.anchor?.closest<HTMLElement>('.cm-scroller') ?? null;

    if (this.scrollTarget) {
      const target: HTMLElement = this.scrollTarget;

      target.addEventListener('scroll', onScroll);
      this.cleanups.push((): void => target.removeEventListener('scroll', onScroll));
    }
  }

  /**
   * Positions the panel to the right of the anchored gutter element at the
   * marker's vertical position, flipping to the left and clamping to the viewport
   * so it never renders off-screen. Uses `position: fixed` (from CSS) with
   * viewport coordinates, so it needs no scroll-offset math.
   */
  protected reposition(): void {
    if (!this.panel || !this.anchor) {
      return;
    }

    const gap: number = GutterHoverPanel.GAP_PX;
    const rect: DOMRect = this.anchor.getBoundingClientRect();
    const width: number = this.panel.offsetWidth;
    const height: number = this.panel.offsetHeight;
    const viewportWidth: number = window.innerWidth;
    const viewportHeight: number = window.innerHeight;

    let left: number = rect.right + gap;

    // Flip to the left of the gutter when the panel would overflow the right edge.
    if (left + width > viewportWidth - gap) {
      left = rect.left - gap - width;
    }

    left = Math.max(gap, Math.min(left, viewportWidth - gap - width));

    const top: number = Math.max(gap, Math.min(rect.top, viewportHeight - gap - height));

    this.panel.style.left = `${Math.round(left)}px`;
    this.panel.style.top = `${Math.round(top)}px`;
  }

  /**
   * Removes the panel from the DOM, runs every registered listener remover, and
   * returns the controller to the closed state. The single teardown path for
   * both the pointer close and every host-driven dismissal.
   */
  protected unmount(): void {
    for (const cleanup of this.cleanups) {
      cleanup();
    }

    this.cleanups = [];
    this.panel?.remove();
    this.panel = null;
    this.scrollTarget = null;
    this.reset();
  }

  /** Cancels a pending open timer, if any. */
  protected clearOpenTimer(): void {
    if (this.openTimer !== null) {
      clearTimeout(this.openTimer);
      this.openTimer = null;
    }
  }

  /** Cancels a pending close timer, if any. */
  protected clearCloseTimer(): void {
    if (this.closeTimer !== null) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
  }

  /** Clears the anchor state and returns the machine to closed. */
  protected reset(): void {
    this.clearCloseTimer();
    this.state = GutterHoverPanelState.closed;
    this.anchor = null;
    this.line = -1;
  }
}
