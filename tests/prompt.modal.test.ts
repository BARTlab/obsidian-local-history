import { describe, expect, it } from 'vitest';
import { PromptModal } from '@/modals/prompt.modal';
import type { App } from 'obsidian';

/**
 * Unit tests for PromptModal.
 *
 * This file runs under the default `node` test environment (no jsdom
 * docblock), so these tests do not exercise the rendered DOM. They
 * focus on the modal's promise contract instead, which is the public surface
 * the rest of the plugin depends on:
 * - confirm with text resolves to that text,
 * - cancel resolves to null,
 * - any close path that did not flow through the confirm button is treated as
 *   a cancel (default `result` is null).
 *
 * The DOM-level keyboard ergonomics (Enter inside the input confirms) are
 * covered by the manual Obsidian check listed in the task's done-when.
 */
describe('PromptModal', () => {
  /**
   * Test-only subclass that bypasses the DOM-touching open path and exposes
   * the protected `result` field plus a tiny harness around the close path.
   * The real `confirmResult` reads the input element to capture the value;
   * under the node test env there is no input element, so we set `result`
   * directly and invoke `close`/`onClose` to drive the resolver.
   */
  class TestablePromptModal extends PromptModal {
    public setResult(value: string | null): void {
      this.result = value;
    }

    public finish(): void {
      // Mirror what the real modal does on close: fire onClose so the
      // promise resolver runs with the current `result`.
      this.onClose();
    }
  }

  const inertApp: App = {} as App;

  it('resolves to the result the confirm path captured before close', async () => {
    const modal: TestablePromptModal = new TestablePromptModal(inertApp, {
      title: 'Enter label',
      placeholder: 'label',
    });

    const pending: Promise<string | null> = modal.prompt();

    // Simulate the confirm path: confirmResult would set `result` to the
    // input's value and close the modal.
    modal.setResult('my-label');
    modal.finish();

    await expect(pending).resolves.toBe('my-label');
  });

  it('resolves to null on cancel', async () => {
    const modal: TestablePromptModal = new TestablePromptModal(inertApp, {
      title: 'Enter label',
    });

    const pending: Promise<string | null> = modal.prompt();

    // The cancel button sets `result` back to null and closes; the default
    // initial value is already null, so closing without touching the result
    // is the same as cancelling.
    modal.setResult(null);
    modal.finish();

    await expect(pending).resolves.toBeNull();
  });

  it('treats a non-confirm close path as a cancel (result stays null)', async () => {
    const modal: TestablePromptModal = new TestablePromptModal(inertApp, {
      title: 'Enter label',
    });

    const pending: Promise<string | null> = modal.prompt();

    // Do not touch `result`: close paths like Escape or clicking outside
    // never run confirmResult, so the default null must propagate.
    modal.finish();

    await expect(pending).resolves.toBeNull();
  });

  it('resolves to an empty string when the user confirms an empty input', async () => {
    // PromptModal does not trim or post-process the value: blank confirmation
    // returns '', and callers are responsible for treating blanks as a
    // no-op. This locks the thin-input-layer contract.
    const modal: TestablePromptModal = new TestablePromptModal(inertApp, {
      title: 'Enter label',
    });

    const pending: Promise<string | null> = modal.prompt();

    modal.setResult('');
    modal.finish();

    await expect(pending).resolves.toBe('');
  });
});
