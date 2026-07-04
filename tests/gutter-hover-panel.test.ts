/** @jest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { GutterHoverPanel } from '@/components/gutter-hover-panel';
import { resolveHoverPanelContent } from '@/components/gutter-hover-panel-content';
import { GutterHoverPanelContentKind, GutterHoverPanelState } from '@/components/gutter-hover-panel.types';
import type { GutterHoverPanelContent, GutterHoverPanelHost } from '@/components/gutter-hover-panel.types';
import * as HunkHelper from '@/helpers/hunk.helper';
import type * as Diff from 'diff';

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
  let content: GutterHoverPanelContent | null;
  let revertSpy: jest.Mock;
  let copySpy: jest.Mock;
  let historySpy: jest.Mock;

  /** A single word segment for a fake content model. */
  const segment = (text: string, added: boolean, removed: boolean): { text: string; added: boolean; removed: boolean } =>
    ({ text, added, removed });

  /** A one-line changed model with a dropped word (a removed span). */
  const changedModel = (): GutterHoverPanelContent => ({
    kind: GutterHoverPanelContentKind.changed,
    lines: [[segment('the ', false, false), segment('quick ', false, true), segment('brown fox', false, false)]],
    blank: false,
  });

  /** The panel's action buttons, in tab order. */
  const actionButtons = (): HTMLButtonElement[] =>
    Array.from(document.body.querySelectorAll<HTMLButtonElement>('.lct-hover-panel-action'));

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

  /** Drains the microtask queue so a settled action promise runs its close. */
  const flush = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
  };

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
    content = changedModel();
    revertSpy = jest.fn((): Promise<void> => Promise.resolve());
    copySpy = jest.fn();
    historySpy = jest.fn();
    host = {
      isEnabled: (): boolean => enabled,
      getContainer: (): HTMLElement => document.body,
      ariaLabel: (): string => ARIA_LABEL,
      resolveContent: (): GutterHoverPanelContent | null => content,
      actionLabels: () => ({ revert: 'Revert', copy: 'Copy', history: 'History' }),
      emptyLabel: (): string => '(empty line)',
      applyIcon: (): void => {
        // No-op: Obsidian's setIcon is unavailable under jsdom.
      },
      revert: (line: number): Promise<void> => revertSpy(line) as Promise<void>,
      copyOldText: (line: number): void => {
        copySpy(line);
      },
      openHistory: (): void => {
        historySpy();
      },
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

  it('caps its max-width to the editor area when an editor ancestor is present', (): void => {
    // Wrap the anchor in a .cm-editor whose width the cap reads: 300 - 2*gap(8) = 284.
    const editor: HTMLElement = document.createElement('div');

    editor.className = 'cm-editor';
    document.body.appendChild(editor);
    editor.appendChild(scroller);
    stubRect(editor, { width: 300, left: 0, right: 300, top: 0, bottom: 600, height: 600 });

    const panel: GutterHoverPanel = build();

    panel.enter(3, anchor);
    jest.advanceTimersByTime(OPEN_DELAY);

    expect(panelEl()?.style.maxWidth).toBe('284px');
  });

  it('caps its max-width to the hard limit on a wide editor', (): void => {
    const editor: HTMLElement = document.createElement('div');

    editor.className = 'cm-editor';
    document.body.appendChild(editor);
    editor.appendChild(scroller);
    // A 2000px editor exceeds the 520px hard cap, so the hard cap wins.
    stubRect(editor, { width: 2000, left: 0, right: 2000, top: 0, bottom: 600, height: 600 });

    const panel: GutterHoverPanel = build();

    panel.enter(3, anchor);
    jest.advanceTimersByTime(OPEN_DELAY);

    expect(panelEl()?.style.maxWidth).toBe('520px');
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

  it('renders the changed state with the hunk base-side content and word-level removed spans', (): void => {
    const panel: GutterHoverPanel = build();

    panel.enter(3, anchor);
    jest.advanceTimersByTime(OPEN_DELAY);

    const slot: HTMLElement = document.body.querySelector('.lct-hover-panel-content') as HTMLElement;

    expect(slot.classList.contains('lct-hover-panel-content-changed')).toBe(true);
    expect(slot.querySelector('.lct-hover-panel-line')).not.toBeNull();
    // A dropped word renders through the existing diff span class.
    expect(slot.querySelector('.lct-word-removed')?.textContent).toBe('quick ');
    expect(slot.querySelector('.lct-word-added')).toBeNull();
  });

  it('renders the added state without old text', (): void => {
    content = {
      kind: GutterHoverPanelContentKind.added,
      lines: [[segment('new line', true, false)]],
      blank: false,
    };

    const panel: GutterHoverPanel = build();

    panel.enter(3, anchor);
    jest.advanceTimersByTime(OPEN_DELAY);

    const slot: HTMLElement = document.body.querySelector('.lct-hover-panel-content') as HTMLElement;

    expect(slot.classList.contains('lct-hover-panel-content-added')).toBe(true);
    expect(slot.querySelector('.lct-word-added')?.textContent).toBe('new line');
    // No previous version: nothing renders as old (removed) text.
    expect(slot.querySelector('.lct-word-removed')).toBeNull();
  });

  it('renders the removed state with the deleted line', (): void => {
    content = {
      kind: GutterHoverPanelContentKind.removed,
      lines: [[segment('gone', false, true)]],
      blank: false,
    };

    const panel: GutterHoverPanel = build();

    panel.enter(3, anchor);
    jest.advanceTimersByTime(OPEN_DELAY);

    const slot: HTMLElement = document.body.querySelector('.lct-hover-panel-content') as HTMLElement;

    expect(slot.classList.contains('lct-hover-panel-content-removed')).toBe(true);
    expect(slot.querySelector('.lct-word-removed')?.textContent).toBe('gone');
  });

  it('renders three focusable action buttons with translated aria-labels', (): void => {
    const panel: GutterHoverPanel = build();

    panel.enter(3, anchor);
    jest.advanceTimersByTime(OPEN_DELAY);

    const buttons: HTMLButtonElement[] = actionButtons();

    expect(buttons).toHaveLength(3);
    expect(buttons.map((button: HTMLButtonElement): string => button.tagName)).toEqual(['BUTTON', 'BUTTON', 'BUTTON']);
    expect(buttons.map((button: HTMLButtonElement): string | null => button.getAttribute('aria-label')))
      .toEqual(['Revert', 'Copy', 'History']);
    buttons.forEach((button: HTMLButtonElement): void => expect(button.getAttribute('type')).toBe('button'));
  });

  it('reverts the change through the host and closes after the confirm settles', async (): Promise<void> => {
    const panel: GutterHoverPanel = build();

    panel.enter(4, anchor);
    jest.advanceTimersByTime(OPEN_DELAY);
    actionButtons()[0].click();

    expect(revertSpy).toHaveBeenCalledWith(4);

    await flush();

    expect(panelEl()).toBeNull();
    expect(panel.getState()).toBe(GutterHoverPanelState.closed);
  });

  it('copies the old text through the host and leaves the panel open', (): void => {
    const panel: GutterHoverPanel = build();

    panel.enter(4, anchor);
    jest.advanceTimersByTime(OPEN_DELAY);
    actionButtons()[1].click();

    expect(copySpy).toHaveBeenCalledWith(4);
    expect(panelEl()).not.toBeNull();
    expect(panel.getState()).toBe(GutterHoverPanelState.open);
  });

  it('disables the copy button on a purely added line so it never confirms an empty copy', (): void => {
    content = {
      kind: GutterHoverPanelContentKind.added,
      lines: [[segment('new line', true, false)]],
      blank: false,
    };

    const panel: GutterHoverPanel = build();

    panel.enter(3, anchor);
    jest.advanceTimersByTime(OPEN_DELAY);

    const copy: HTMLButtonElement = actionButtons()[1];

    expect(copy.disabled).toBe(true);
    // Clicking the disabled button is inert: the host copy never runs, so nothing
    // is written to the clipboard and no "Copied!" notice is shown for a line with
    // no previous version.
    copy.click();
    expect(copySpy).not.toHaveBeenCalled();
    // Revert and history stay usable around the disabled copy.
    expect(actionButtons()[0].disabled).toBe(false);
    expect(actionButtons()[2].disabled).toBe(false);
  });

  it('keeps the copy button enabled and copying for the removed state', (): void => {
    content = {
      kind: GutterHoverPanelContentKind.removed,
      lines: [[segment('gone', false, true)]],
      blank: false,
    };

    const panel: GutterHoverPanel = build();

    panel.enter(5, anchor);
    jest.advanceTimersByTime(OPEN_DELAY);

    const copy: HTMLButtonElement = actionButtons()[1];

    expect(copy.disabled).toBe(false);
    copy.click();
    expect(copySpy).toHaveBeenCalledWith(5);
  });

  it('renders a muted placeholder and disables copy for a blank change', (): void => {
    content = { kind: GutterHoverPanelContentKind.removed, lines: [], blank: true };

    const panel: GutterHoverPanel = build();

    panel.enter(3, anchor);
    jest.advanceTimersByTime(OPEN_DELAY);

    const slot: HTMLElement = document.body.querySelector('.lct-hover-panel-content') as HTMLElement;
    const placeholder: HTMLElement | null = slot.querySelector('.lct-hover-panel-empty');

    // The placeholder stands in for the empty content, and no green/red wash is
    // applied (the blank branch skips the content-kind modifier class).
    expect(placeholder?.textContent).toBe('(empty line)');
    expect(slot.classList.contains('lct-hover-panel-content-removed')).toBe(false);
    expect(slot.querySelector('.lct-word-removed')).toBeNull();
    // Nothing meaningful to copy on a blank line.
    expect(actionButtons()[1].disabled).toBe(true);
  });

  it('re-evaluates the copy disabled state per marker and keeps the Tab cycle between revert and history', (): void => {
    const other: HTMLElement = document.createElement('div');

    other.className = 'cm-gutterElement';
    scroller.appendChild(other);
    stubRect(other, { top: 300, left: 10, right: 14, bottom: 320, width: 4, height: 20 });

    const panel: GutterHoverPanel = build();

    // Opens on a changed marker: copy is live.
    panel.enter(3, anchor);
    jest.advanceTimersByTime(OPEN_DELAY);
    expect(actionButtons()[1].disabled).toBe(false);

    // Re-anchors onto an added marker without a second panel: copy goes disabled.
    content = { kind: GutterHoverPanelContentKind.added, lines: [[segment('added', true, false)]], blank: false };
    panel.enter(9, other);
    expect(document.querySelectorAll('.lct-hover-panel')).toHaveLength(1);

    const buttons: HTMLButtonElement[] = actionButtons();

    expect(buttons[1].disabled).toBe(true);

    // The Tab cycle wraps history -> revert, so it never lands on the disabled
    // copy (the browser skips a disabled control natively; jsdom performs no
    // sequential focus traversal, so this asserts the boundary wrap).
    const last: HTMLButtonElement = buttons[buttons.length - 1];

    last.focus();
    last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(buttons[0]);

    // Back onto a changed marker: copy is live again.
    content = changedModel();
    panel.enter(3, anchor);
    expect(actionButtons()[1].disabled).toBe(false);
  });

  it('opens history through the host and closes the panel', (): void => {
    const panel: GutterHoverPanel = build();

    panel.enter(4, anchor);
    jest.advanceTimersByTime(OPEN_DELAY);
    actionButtons()[2].click();

    expect(historySpy).toHaveBeenCalledTimes(1);
    expect(panelEl()).toBeNull();
    expect(panel.getState()).toBe(GutterHoverPanelState.closed);
  });

  it('traps Tab within the action buttons so focus cycles', (): void => {
    const panel: GutterHoverPanel = build();

    panel.enter(3, anchor);
    jest.advanceTimersByTime(OPEN_DELAY);

    const buttons: HTMLButtonElement[] = actionButtons();
    const last: HTMLButtonElement = buttons[buttons.length - 1];

    // Tab off the last button wraps to the first.
    last.focus();
    last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(buttons[0]);

    // Shift+Tab off the first wraps back to the last.
    buttons[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
    expect(document.activeElement).toBe(last);
  });

  it('closes on Escape and returns focus to the editor', (): void => {
    const editor: HTMLTextAreaElement = document.createElement('textarea');

    document.body.appendChild(editor);
    editor.focus();
    expect(document.activeElement).toBe(editor);

    const panel: GutterHoverPanel = build();

    panel.enter(3, anchor);
    jest.advanceTimersByTime(OPEN_DELAY);
    // Focus enters the panel, then Escape dismisses it.
    actionButtons()[0].focus();
    expect(document.activeElement).not.toBe(editor);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(panelEl()).toBeNull();
    expect(document.activeElement).toBe(editor);
  });
});

/**
 * Tests for {@link resolveHoverPanelContent}, the pure resolver the gutter host
 * builds the panel from. It maps a hovered line to the display model and the
 * block the actions operate on, so these assert the three marker states, that
 * the revert hunk matches what the gutter revert resolves at that line, and that
 * the copy payload is the hunk's base-side text. Pure, so it runs without jsdom.
 */
describe('resolveHoverPanelContent', () => {
  it('resolves a changed line to base-side content, removed spans, and the gutter revert hunk', (): void => {
    const base: string[] = ['the quick brown fox'];
    const current: string[] = ['the brown fox'];
    const resolution = resolveHoverPanelContent(base, current, '\n', 0);

    expect(resolution).not.toBeNull();
    expect(resolution?.content.kind).toBe(GutterHoverPanelContentKind.changed);
    expect((resolution?.content.lines[0] ?? []).some((seg): boolean => seg.removed && seg.text.includes('quick')))
      .toBe(true);

    // The action hunk is exactly the block the dot gutter revert resolves at the line.
    const expected: Diff.StructuredPatchHunk | null = HunkHelper.hunkAtLine(HunkHelper.diff(base, current, '\n'), 0);

    expect(resolution?.hunk).toEqual(expected);
    expect(HunkHelper.revertHunk(current, resolution?.hunk as Diff.StructuredPatchHunk)).toEqual(base);
    expect(resolution?.baseText).toBe('the quick brown fox');
  });

  it('resolves an added line to the added state with no old text', (): void => {
    const base: string[] = ['a', 'c'];
    const current: string[] = ['a', 'b', 'c'];
    const resolution = resolveHoverPanelContent(base, current, '\n', 1);

    expect(resolution?.content.kind).toBe(GutterHoverPanelContentKind.added);

    const segments = (resolution?.content.lines ?? []).flat();

    expect(segments.some((seg): boolean => seg.added && seg.text.includes('b'))).toBe(true);
    expect(segments.some((seg): boolean => seg.removed)).toBe(false);
    expect(resolution?.baseText).toBe('');
    // Reverting removes the added line.
    expect(HunkHelper.revertHunk(current, resolution?.hunk as Diff.StructuredPatchHunk)).toEqual(base);
  });

  it('resolves a removed dash to the deleted base line and the pure-deletion revert hunk', (): void => {
    const base: string[] = ['a', 'b', 'c'];
    const current: string[] = ['a', 'c'];
    // The removed dash sits on the first current line after the gap.
    const resolution = resolveHoverPanelContent(base, current, '\n', 1);

    expect(resolution?.content.kind).toBe(GutterHoverPanelContentKind.removed);
    expect((resolution?.content.lines ?? []).flat().some((seg): boolean => seg.removed && seg.text.includes('b')))
      .toBe(true);
    expect(resolution?.baseText).toBe('b');
    expect(resolution?.hunk.newLines).toBe(0);
    expect(HunkHelper.revertHunk(current, resolution?.hunk as Diff.StructuredPatchHunk)).toEqual(base);
  });

  it('resolves a last-line deletion through the clamped end-of-file anchor', (): void => {
    const base: string[] = ['a', 'b', 'c'];
    const current: string[] = ['a', 'b'];
    // Deleting the last line clamps the anchor onto the new last line.
    const resolution = resolveHoverPanelContent(base, current, '\n', 1);

    expect(resolution?.content.kind).toBe(GutterHoverPanelContentKind.removed);
    expect(resolution?.baseText).toBe('c');
    expect(HunkHelper.revertHunk(current, resolution?.hunk as Diff.StructuredPatchHunk)).toEqual(base);
  });

  it('returns null when no change block covers the line', (): void => {
    expect(resolveHoverPanelContent(['a', 'b'], ['a', 'b'], '\n', 0)).toBeNull();
  });

  it('flags a blank added line as blank, and a real added line as not blank', (): void => {
    // An inserted empty line: added state, but no visible text on either side.
    const blankAdded = resolveHoverPanelContent(['a', 'b'], ['a', '', 'b'], '\n', 1);

    expect(blankAdded?.content.kind).toBe(GutterHoverPanelContentKind.added);
    expect(blankAdded?.content.blank).toBe(true);

    // An inserted line with real text is added but not blank.
    const realAdded = resolveHoverPanelContent(['a', 'b'], ['a', 'x', 'b'], '\n', 1);

    expect(realAdded?.content.blank).toBe(false);
  });

  it('flags a whitespace-only line as blank', (): void => {
    // A line changed to only spaces carries no visible text: treated as blank.
    const resolution = resolveHoverPanelContent(['a', 'b'], ['a', '   ', 'b'], '\n', 1);

    expect(resolution?.content.blank).toBe(true);
  });
});
