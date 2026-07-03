/** @jest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { GutterHoverPanel } from '@/components/gutter-hover-panel';
import { GutterHoverPanelState } from '@/components/gutter-hover-panel.types';
import type { GutterHoverPanelHost } from '@/components/gutter-hover-panel.types';

/**
 * Tests for {@link GutterHoverPanel}, the shell of the JetBrains-style gutter
 * hover panel: the controller, its positioning, and its open/close lifecycle
 * (the content and actions land in a later task). They run under jsdom and drive
 * the state machine through the controller's public surface:
 *
 * - a hovered marker opens exactly one panel after the open dwell, anchored to
 *   the marker and never doubled, and re-anchors when the pointer moves,
 * - leaving before the dwell cancels the pending open (no panel is created),
 * - the pointer bridging marker -> panel keeps it open, and leaving both closes
 *   it after the close grace,
 * - Escape, an editor scroll, an external dismiss (document change / active-leaf
 *   change / settings off), and teardown all unmount the panel and detach every
 *   listener and timer,
 * - a disabled feature never mounts a panel, and
 * - the panel carries its dialog semantics and leaves colour to the stylesheet.
 *
 * jsdom performs no layout, so the anchor's rect is stubbed to make the
 * positioning math deterministic, and fake timers drive the dwell and grace.
 */
describe('GutterHoverPanel', () => {
  const OPEN_DELAY: number = 200;
  const CLOSE_DELAY: number = 200;
  const ARIA_LABEL: string = 'Local history';

  let scroller: HTMLElement;
  let anchor: HTMLElement;
  let enabled: boolean;
  let host: GutterHoverPanelHost;

  /**
   * Overrides an element's layout rect so positioning is testable under jsdom,
   * which otherwise reports an all-zero rect.
   *
   * @param {HTMLElement} element - The element to stub
   * @param {Partial<DOMRect>} rect - The rect fields to report
   */
  const stubRect = (element: HTMLElement, rect: Partial<DOMRect>): void => {
    element.getBoundingClientRect = (): DOMRect => ({
      x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0,
      toJSON: (): object => ({}),
      ...rect,
    }) as DOMRect;
  };

  /** The mounted panel element, or null when none is mounted. */
  const panelEl = (): HTMLElement | null => document.body.querySelector('.lct-hover-panel');

  /** A fresh controller with the fixed test delays. */
  const build = (): GutterHoverPanel =>
    new GutterHoverPanel(host, { openDelayMs: OPEN_DELAY, closeDelayMs: CLOSE_DELAY });

  beforeEach((): void => {
    jest.useFakeTimers();
    enabled = true;
    scroller = document.createElement('div');
    scroller.className = 'cm-scroller';
    anchor = document.createElement('div');
    anchor.className = 'cm-gutterElement';
    scroller.appendChild(anchor);
    document.body.appendChild(scroller);
    stubRect(anchor, { top: 100, left: 10, right: 14, bottom: 120, width: 4, height: 20 });
    host = {
      isEnabled: (): boolean => enabled,
      getContainer: (): HTMLElement => document.body,
      ariaLabel: (): string => ARIA_LABEL,
    };
  });

  afterEach((): void => {
    jest.clearAllTimers();
    jest.useRealTimers();
    document.body.innerHTML = '';
  });

  it('opens exactly one panel after the open delay, anchored to the right of the marker', (): void => {
    const panel: GutterHoverPanel = build();

    panel.enter(3, anchor);
    // Still pending: nothing is mounted before the dwell elapses.
    expect(panelEl()).toBeNull();
    expect(panel.getState()).toBe(GutterHoverPanelState.pending);

    jest.advanceTimersByTime(OPEN_DELAY);

    const element: HTMLElement | null = panelEl();

    expect(element).not.toBeNull();
    expect(document.querySelectorAll('.lct-hover-panel')).toHaveLength(1);
    expect(panel.getState()).toBe(GutterHoverPanelState.open);
    expect(panel.getLine()).toBe(3);
    expect(element?.querySelector('.lct-hover-panel-content')).not.toBeNull();
    // To the right of the gutter (anchor.right 14 + gap 8) at the marker's top.
    expect(element?.style.left).toBe('22px');
    expect(element?.style.top).toBe('100px');
  });

  it('re-anchors to another marker without ever creating a second panel', (): void => {
    const other: HTMLElement = document.createElement('div');

    other.className = 'cm-gutterElement';
    scroller.appendChild(other);
    stubRect(other, { top: 300, left: 10, right: 14, bottom: 320, width: 4, height: 20 });

    const panel: GutterHoverPanel = build();

    panel.enter(3, anchor);
    jest.advanceTimersByTime(OPEN_DELAY);
    // Move the pointer onto a different marker while the panel is open.
    panel.enter(9, other);

    expect(document.querySelectorAll('.lct-hover-panel')).toHaveLength(1);
    expect(panel.getLine()).toBe(9);
    // Re-positioned to the new marker's vertical position.
    expect(panelEl()?.style.top).toBe('300px');
  });

  it('creates no panel when the pointer leaves before the open delay elapses', (): void => {
    const panel: GutterHoverPanel = build();

    panel.enter(3, anchor);
    jest.advanceTimersByTime(OPEN_DELAY - 1);
    panel.leave();
    jest.advanceTimersByTime(OPEN_DELAY);

    expect(panelEl()).toBeNull();
    expect(panel.getState()).toBe(GutterHoverPanelState.closed);
  });

  it('stays open across the marker-to-panel bridge and unmounts after leaving both', (): void => {
    const panel: GutterHoverPanel = build();

    panel.enter(3, anchor);
    jest.advanceTimersByTime(OPEN_DELAY);

    const element: HTMLElement = panelEl() as HTMLElement;

    // Pointer leaves the marker: the close grace starts (the hover bridge window).
    panel.leave();
    expect(panel.getState()).toBe(GutterHoverPanelState.closing);

    // Pointer reaches the panel before the grace elapses: it stays open.
    element.dispatchEvent(new Event('mouseenter'));
    jest.advanceTimersByTime(CLOSE_DELAY);
    expect(panelEl()).not.toBeNull();
    expect(panel.getState()).toBe(GutterHoverPanelState.open);

    // Pointer leaves the panel: the grace runs out and it unmounts.
    element.dispatchEvent(new Event('mouseleave'));
    expect(panel.getState()).toBe(GutterHoverPanelState.closing);
    jest.advanceTimersByTime(CLOSE_DELAY);
    expect(panelEl()).toBeNull();
    expect(panel.getState()).toBe(GutterHoverPanelState.closed);
  });

  it('closes on Escape and detaches its document key listener', (): void => {
    const removeSpy = jest.spyOn(document, 'removeEventListener');
    const panel: GutterHoverPanel = build();

    panel.enter(3, anchor);
    jest.advanceTimersByTime(OPEN_DELAY);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(panelEl()).toBeNull();
    expect(panel.getState()).toBe(GutterHoverPanelState.closed);
    expect(removeSpy).toHaveBeenCalledWith('keydown', expect.any(Function));
  });

  it('closes when the editor scroller scrolls and detaches the scroll listener', (): void => {
    const removeSpy = jest.spyOn(scroller, 'removeEventListener');
    const panel: GutterHoverPanel = build();

    panel.enter(3, anchor);
    jest.advanceTimersByTime(OPEN_DELAY);
    scroller.dispatchEvent(new Event('scroll'));

    expect(panelEl()).toBeNull();
    expect(removeSpy).toHaveBeenCalledWith('scroll', expect.any(Function));
  });

  it('closes on an external dismiss (document change / active-leaf change / settings off)', (): void => {
    const panel: GutterHoverPanel = build();

    panel.enter(3, anchor);
    jest.advanceTimersByTime(OPEN_DELAY);
    panel.dismiss();

    expect(panelEl()).toBeNull();
    expect(panel.getState()).toBe(GutterHoverPanelState.closed);
  });

  it('cancels a pending open when dismissed before the dwell elapses', (): void => {
    const panel: GutterHoverPanel = build();

    panel.enter(3, anchor);
    panel.dismiss();
    jest.advanceTimersByTime(OPEN_DELAY);

    expect(panelEl()).toBeNull();
    expect(panel.getState()).toBe(GutterHoverPanelState.closed);
  });

  it('disposes on destroy and refuses to open afterwards', (): void => {
    const panel: GutterHoverPanel = build();

    panel.enter(3, anchor);
    jest.advanceTimersByTime(OPEN_DELAY);
    panel.destroy();
    expect(panelEl()).toBeNull();

    // A late hover after teardown must not resurrect the panel.
    panel.enter(3, anchor);
    jest.advanceTimersByTime(OPEN_DELAY);
    expect(panelEl()).toBeNull();
    expect(panel.getState()).toBe(GutterHoverPanelState.closed);
  });

  it('never creates a panel while the feature is disabled', (): void => {
    enabled = false;

    const panel: GutterHoverPanel = build();

    panel.enter(3, anchor);
    jest.advanceTimersByTime(OPEN_DELAY);

    expect(panelEl()).toBeNull();
    expect(panel.getState()).toBe(GutterHoverPanelState.closed);
  });

  it('flips to the left of the marker when it would overflow the right viewport edge', (): void => {
    stubRect(anchor, { top: 100, left: 1010, right: 1020, bottom: 120, width: 10, height: 20 });

    const panel: GutterHoverPanel = build();

    panel.enter(3, anchor);
    jest.advanceTimersByTime(OPEN_DELAY);

    // Right placement (1020 + gap) overflows innerWidth, so it flips left of the marker.
    expect(Number.parseInt(panelEl()?.style.left ?? '', 10)).toBeLessThan(1010);
  });

  it('carries dialog semantics and leaves colour to the stylesheet', (): void => {
    const panel: GutterHoverPanel = build();

    panel.enter(3, anchor);
    jest.advanceTimersByTime(OPEN_DELAY);

    const element: HTMLElement = panelEl() as HTMLElement;

    expect(element.getAttribute('role')).toBe('dialog');
    expect(element.getAttribute('aria-label')).toBe(ARIA_LABEL);
    expect(element.classList.contains('lct-hover-panel')).toBe(true);
    // Only positional inline styles: colour and background come from the class
    // (theme tokens), never inline, so the panel tracks the active theme.
    expect(element.style.color).toBe('');
    expect(element.style.backgroundColor).toBe('');
  });
});
