/** @vitest-environment jsdom */

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ConfirmModal } from '@/modals/confirm.modal';
import type { ConfirmModalConfig } from '@/types';
import type { App } from 'obsidian';
import { installJsdomDomPolyfill } from './helpers/jsdom-dom';

/**
 * Tests for {@link ConfirmModal}. The modal renders a title, a message, and a
 * cancel/confirm button pair, resolves a promise with the user's choice, and
 * focuses the confirm button on open. ConfirmModal itself registers no keyboard
 * listeners: Escape-to-close and Enter-on-focused-button are the Obsidian Modal
 * base and browser defaults. The suite therefore covers the code the modal owns
 * - rendered DOM, button wiring, the promise contract, and the confirm-button
 * focus that enables the Enter-confirms ergonomic - plus the dismiss path where
 * a close that bypasses the buttons resolves to the default cancel.
 */
describe('ConfirmModal', () => {
  beforeAll((): void => {
    installJsdomDomPolyfill();
  });

  /**
   * Test-only subclass that supplies the DOM anchors the inert Obsidian stub
   * omits and reproduces the base lifecycle wiring: the real Modal.open() runs
   * onOpen() (render) and Modal.close() runs onClose() (promise resolve), so the
   * public confirm()/click/close flow drives the modal end to end under jsdom.
   * contentEl is connected to the document so the confirm button can take focus.
   */
  class TestableConfirmModal extends ConfirmModal {
    public constructor(app: App, config: ConfirmModalConfig, t: (key: string) => string) {
      super(app, config, t);

      this.modalEl = document.createElement('div');
      this.contentEl = document.createElement('div');
      document.body.appendChild(this.contentEl);
    }

    public override open(): void {
      this.onOpen();
    }

    public override close(): void {
      this.onClose();
    }
  }

  const echoTranslator = (key: string): string => key;

  const makeModal = (config: ConfirmModalConfig = {}): TestableConfirmModal =>
    new TestableConfirmModal({} as App, config, echoTranslator);

  const confirmButtonOf = (modal: TestableConfirmModal): HTMLButtonElement =>
    modal.contentEl.querySelector<HTMLButtonElement>('button.mod-warning') as HTMLButtonElement;

  const cancelButtonOf = (modal: TestableConfirmModal): HTMLButtonElement =>
    modal.contentEl.querySelector<HTMLButtonElement>(
      '.modal-button-container button:not(.mod-warning)'
    ) as HTMLButtonElement;

  afterEach((): void => {
    document.body.replaceChildren();
  });

  it('renders the configured title, message, and button labels', () => {
    const modal: TestableConfirmModal = makeModal({
      title: 'Revert this change',
      message: 'This cannot be undone.',
      confirmText: 'Revert',
      cancelText: 'Keep',
    });

    modal.open();

    expect(modal.contentEl.querySelector('h2')?.textContent).toBe('Revert this change');
    expect(modal.contentEl.querySelector('p')?.textContent).toBe('This cannot be undone.');
    expect(confirmButtonOf(modal).textContent).toBe('Revert');
    expect(cancelButtonOf(modal).textContent).toBe('Keep');
    expect(modal.modalEl.classList.contains('lct-confirm-modal')).toBe(true);
  });

  it('falls back to the translated default texts when the config omits them', () => {
    const modal: TestableConfirmModal = makeModal();

    modal.open();

    expect(modal.contentEl.querySelector('h2')?.textContent).toBe('modal.confirm.default.title');
    expect(modal.contentEl.querySelector('p')?.textContent).toBe('modal.confirm.default.message');
    expect(confirmButtonOf(modal).textContent).toBe('modal.confirm.default.ok');
    expect(cancelButtonOf(modal).textContent).toBe('modal.confirm.default.cancel');
  });

  it('focuses the confirm button on open so Enter confirms', () => {
    const modal: TestableConfirmModal = makeModal();

    modal.open();

    expect(document.activeElement).toBe(confirmButtonOf(modal));
  });

  it('resolves the promise true when the confirm button is clicked', async () => {
    const modal: TestableConfirmModal = makeModal();

    const pending: Promise<boolean> = modal.confirm();
    confirmButtonOf(modal).click();

    await expect(pending).resolves.toBe(true);
  });

  it('resolves the promise false when the cancel button is clicked', async () => {
    const modal: TestableConfirmModal = makeModal();

    const pending: Promise<boolean> = modal.confirm();
    cancelButtonOf(modal).click();

    await expect(pending).resolves.toBe(false);
  });

  it('resolves the promise false when closed without touching a button (dismiss/Escape)', async () => {
    const modal: TestableConfirmModal = makeModal();

    const pending: Promise<boolean> = modal.confirm();
    // A dismiss path (Escape, click-outside) closes without running a button
    // handler, so the default result must propagate as a cancel.
    modal.close();

    await expect(pending).resolves.toBe(false);
  });
});
