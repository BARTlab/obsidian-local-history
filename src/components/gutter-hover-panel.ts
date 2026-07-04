import type {
  GutterHoverPanelContent,
  GutterHoverPanelHost,
  GutterHoverPanelTimings,
} from '@/components/gutter-hover-panel.types';
import { GutterHoverPanelState } from '@/components/gutter-hover-panel.types';
import type { FunctionVoid } from '@/types';

/**
 * Hand-rolled anchored panel that appears next to a hovered gutter bar marker
 * after a short dwell and disappears predictably (ADR D-001: a controller-owned
 * absolutely-positioned div, not an Obsidian `HoverPopover` or `Menu`). It owns
 * the open/close state machine, the viewport-clamped positioning, and every
 * listener and timer, and it fills the panel from the host: the previous version
 * of the hovered line (word-level old-vs-new spans) and three actions (revert
 * this change, copy the old text, open history).
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

  /** The content slot, re-rendered when the panel re-anchors to another marker. */
  protected contentSlot: HTMLElement | null = null;

  /** The action buttons, in tab order, used by the in-panel focus trap. */
  protected actionButtons: HTMLButtonElement[] = [];

  /** The gutter element the panel is anchored to, captured at hover. */
  protected anchor: HTMLElement | null = null;

  /** The 0-based line the anchored marker sits on (-1 when closed). */
  protected line: number = -1;

  /** The editor scroller listened to for the scroll-dismiss, resolved on mount. */
  protected scrollTarget: HTMLElement | null = null;

  /** The element focused when the panel opened, restored when a focused panel closes. */
  protected previouslyFocused: HTMLElement | null = null;

  /** Pending open-delay timer, or null when no open is scheduled. */
  protected openTimer: ReturnType<typeof setTimeout> | null = null;

  /** Pending close-delay timer, or null when no close is scheduled. */
  protected closeTimer: ReturnType<typeof setTimeout> | null = null;

  /** Listener removers registered on mount, run once on unmount. */
  protected cleanups: FunctionVoid[] = [];

  /** True after {@link destroy}, so a late hover cannot resurrect the panel. */
  protected destroyed: boolean = false;

  /**
   * @param {GutterHoverPanelHost} host - Environment port (gate, mount target,
   *   label, content, actions).
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
   * the hovered line reached the controller and drives which change block the
   * content and actions read.
   *
   * @return {number} The anchored 0-based line, or -1
   */
  public getLine(): number {
    return this.line;
  }

  /**
   * Hover intent over a marker: schedules the open after the dwell, or re-anchors
   * an already-open panel to the new marker (never a second panel), re-rendering
   * its content for the new line. A disabled feature or a destroyed controller is
   * a no-op, so no panel is ever created while the setting is off.
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
        this.renderContent();
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
   * `dialog` role, renders the hovered line's content into it, appends the action
   * row, wires the hover-bridge, focus-trap, and dismissal listeners, and
   * positions it. Records the previously focused element so a keyboard dismissal
   * can hand focus back to the editor.
   */
  protected mount(): void {
    this.openTimer = null;

    // A dismissal between arming and firing the timer clears the anchor.
    if (!this.anchor || this.destroyed) {
      this.reset();

      return;
    }

    this.previouslyFocused = document.activeElement as HTMLElement | null;

    const panel: HTMLElement = document.createElement('div');

    panel.className = 'lct-hover-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', this.host.ariaLabel());

    const content: HTMLElement = document.createElement('div');

    content.className = 'lct-hover-panel-content';
    panel.appendChild(content);

    this.panel = panel;
    this.contentSlot = content;
    this.renderContent();
    panel.appendChild(this.buildActions());

    this.host.getContainer().appendChild(panel);
    this.state = GutterHoverPanelState.open;

    this.wireListeners(panel);
    this.reposition();
  }

  /**
   * Fills the content slot with the hovered line's model: a modifier class for
   * the marker state and one row per content line, each row a run of word
   * segments carrying the shared diff span classes (removed for dropped words,
   * added for inserted ones). A line that resolves to no change block leaves the
   * slot empty. Rebuilt from scratch on every anchor change.
   */
  protected renderContent(): void {
    const slot: HTMLElement | null = this.contentSlot;

    if (!slot) {
      return;
    }

    slot.replaceChildren();
    slot.className = 'lct-hover-panel-content';

    const model: GutterHoverPanelContent | null = this.host.resolveContent(this.line);

    if (!model) {
      return;
    }

    slot.classList.add(`lct-hover-panel-content-${model.kind}`);

    for (const segments of model.lines) {
      const row: HTMLElement = document.createElement('div');

      row.className = 'lct-hover-panel-line';

      for (const segment of segments) {
        const span: HTMLElement = document.createElement('span');

        if (segment.added) {
          span.className = 'lct-word-added';
        } else if (segment.removed) {
          span.className = 'lct-word-removed';
        }

        span.textContent = segment.text;
        row.appendChild(span);
      }

      slot.appendChild(row);
    }
  }

  /**
   * Builds the action row: revert this change, copy the old text, open history.
   * Each is a real focusable `button` with a translated `aria-label` and a Lucide
   * icon (set through the host so the controller keeps no Obsidian import).
   *
   * @return {HTMLElement} The action row element
   */
  protected buildActions(): HTMLElement {
    const labels = this.host.actionLabels();
    const row: HTMLElement = document.createElement('div');

    row.className = 'lct-hover-panel-actions';
    this.actionButtons = [
      this.buildAction(row, 'undo-2', labels.revert, (): void => this.onRevert()),
      this.buildAction(row, 'copy', labels.copy, (): void => this.onCopy()),
      this.buildAction(row, 'history', labels.history, (): void => this.onHistory()),
    ];

    return row;
  }

  /**
   * Builds one action button, appends it to the row, and wires its click. Click
   * propagation is stopped so it never reaches the editor beneath the panel.
   *
   * @param {HTMLElement} row - The action row to append to
   * @param {string} icon - The Lucide icon id
   * @param {string} label - The translated accessible label
   * @param {FunctionVoid} handler - The click handler
   * @return {HTMLButtonElement} The built button
   */
  protected buildAction(row: HTMLElement, icon: string, label: string, handler: FunctionVoid): HTMLButtonElement {
    const button: HTMLButtonElement = document.createElement('button');

    button.type = 'button';
    button.className = 'lct-hover-panel-action clickable-icon';
    button.setAttribute('aria-label', label);
    this.host.applyIcon(button, icon);
    button.addEventListener('click', (event: MouseEvent): void => {
      event.preventDefault();
      event.stopPropagation();
      handler();
    });
    row.appendChild(button);

    return button;
  }

  /**
   * Reverts the hovered change block through the host (which confirms first), then
   * closes the panel once the confirm settles, whether it was accepted or
   * declined. A successful revert also redraws the gutter, which dismisses the
   * panel through the host's snapshot subscription; the explicit close covers the
   * declined case and is idempotent.
   */
  protected onRevert(): void {
    void this.host.revert(this.line).then((): void => this.dismiss());
  }

  /** Copies the hovered block's old text through the host; the panel stays open. */
  protected onCopy(): void {
    this.host.copyOldText(this.line);
  }

  /** Opens the file history through the host and closes the panel. */
  protected onHistory(): void {
    this.host.openHistory();
    this.dismiss();
  }

  /**
   * Adds the panel-scoped listeners and records their removers so unmount can run
   * them: the hover bridge (pointer into the panel keeps it open, out of it
   * starts the close grace), the Tab focus trap, Escape, and editor scroll.
   *
   * @param {HTMLElement} panel - The freshly mounted panel element
   */
  protected wireListeners(panel: HTMLElement): void {
    const onPanelEnter: FunctionVoid = (): void => {
      this.clearCloseTimer();
      this.state = GutterHoverPanelState.open;
    };

    const onPanelLeave: FunctionVoid = (): void => this.leave();

    const onPanelKeyDown = (event: KeyboardEvent): void => this.trapTab(event);

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        this.dismiss();
      }
    };

    const onScroll: FunctionVoid = (): void => this.dismiss();

    panel.addEventListener('mouseenter', onPanelEnter);
    panel.addEventListener('mouseleave', onPanelLeave);
    panel.addEventListener('keydown', onPanelKeyDown);
    document.addEventListener('keydown', onKeyDown);
    this.cleanups.push((): void => {
      panel.removeEventListener('mouseenter', onPanelEnter);
      panel.removeEventListener('mouseleave', onPanelLeave);
      panel.removeEventListener('keydown', onPanelKeyDown);
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
   * Keeps Tab within the action buttons once focus is inside the panel: Tab off
   * the last button wraps to the first and Shift+Tab off the first wraps to the
   * last, so the panel's actions form a closed keyboard cycle. How focus first
   * enters the hover-triggered panel is a separate, deferred keyboard-reach
   * question; this only governs the cycle once it is in.
   *
   * @param {KeyboardEvent} event - The panel keydown
   */
  protected trapTab(event: KeyboardEvent): void {
    if (event.key !== 'Tab' || this.actionButtons.length === 0) {
      return;
    }

    const active: Element | null = document.activeElement;
    const first: HTMLButtonElement = this.actionButtons[0];
    const last: HTMLButtonElement = this.actionButtons[this.actionButtons.length - 1];

    if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
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
   * Removes the panel from the DOM, runs every registered listener remover, hands
   * focus back to the editor when the panel being torn down held it, and returns
   * the controller to the closed state. The single teardown path for both the
   * pointer close and every host-driven dismissal.
   */
  protected unmount(): void {
    const heldFocus: boolean = this.panel?.contains(document.activeElement) ?? false;

    for (const cleanup of this.cleanups) {
      cleanup();
    }

    this.cleanups = [];
    this.panel?.remove();
    this.panel = null;
    this.contentSlot = null;
    this.actionButtons = [];
    this.scrollTarget = null;

    if (heldFocus) {
      this.previouslyFocused?.focus();
    }

    this.previouslyFocused = null;
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
