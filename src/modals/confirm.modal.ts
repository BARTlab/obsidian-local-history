import { DomHelper } from '@/helpers/dom.helper';
import type { ConfirmModalConfig } from '@/types';
import { type App, Modal } from 'obsidian';

/**
 * Simple confirmation modal for destructive operations.
 * Provides a standardized way to ask for user confirmation before performing
 * potentially destructive actions like deleting data or resetting state.
 *
 * @extends {Modal}
 */
export class ConfirmModal extends Modal {
  /**
   * The result of the user's choice.
   * True if confirmed, false if canceled.
   */
  protected result: boolean = false;

  /**
   * Promise resolver function to return the user's choice.
   * Called when the modal is closed.
   */
  protected resolvePromise: ((value: boolean) => void) | undefined;

  /**
   * The title text displayed in the modal header.
   */
  protected readonly title: string;

  /**
   * The message text displayed in the modal body.
   */
  protected readonly message: string;

  /**
   * The text displayed on the confirmation button.
   */
  protected readonly confirmText: string;

  /**
   * The text displayed on the cancel button.
   */
  protected readonly cancelText: string;

  /**
   * Creates a new instance of ConfirmModal.
   *
   * @param {App} app - The Obsidian app instance
   * @param {ConfirmModalConfig} config - Configuration object for the modal
   * @param {(key: string) => string} t - Translation function for localized default texts
   */
  public constructor(
    app: App,
    config: ConfirmModalConfig,
    t: (key: string) => string
  ) {
    super(app);

    this.title = config.title ?? t('modal.confirm.default.title');
    this.message = config.message ?? t('modal.confirm.default.message');
    this.confirmText = config.confirmText ?? t('modal.confirm.default.ok');
    this.cancelText = config.cancelText ?? t('modal.confirm.default.cancel');
  }

  /**
   * Called when the modal is opened.
   * Creates the modal content with title, message, and action buttons.
   * Sets up event handlers for the buttons and focused the confirmation button.
   *
   * @override
   */
  public onOpen(): void {
    /**
     * Tag the modal so the stylesheet can restore the content padding; a bare
     * Modal's content otherwise sits flush against the edges.
     */
    DomHelper.update(this.modalEl, { classes: { add: 'lct-confirm-modal' } });

    DomHelper.update(this.contentEl, {
      children: [
        {
          tag: 'div',
          children: [
            {
              tag: 'h2',
              text: this.title
            },
            {
              tag: 'p',
              text: this.message
            },
            {
              tag: 'div',
              classes: 'modal-button-container',
              children: [
                {
                  tag: 'button',
                  text: this.cancelText,
                  events: {
                    click: (): void => {
                      this.result = false;
                      this.close();
                    }
                  }
                },
                {
                  tag: 'button',
                  text: this.confirmText,
                  classes: 'mod-warning',
                  events: {
                    click: (): void => {
                      this.result = true;
                      this.close();
                    }
                  }
                }
              ]
            }
          ]
        }
      ]
    })

    /**
     * Focus the confirmation button
     */
    const confirmButton: HTMLButtonElement | null = this.contentEl.querySelector('button.mod-warning');

    confirmButton?.focus();
  }

  /**
   * Called when the modal is closed.
   * Resolves the promise with the user's choice (result).
   * This ensures the confirm() method returns the appropriate boolean value.
   *
   * @override
   */
  public onClose(): void {
    if (this.resolvePromise) {
      this.resolvePromise(this.result);
    }
  }

  /**
   * Shows the confirmation modal and returns a promise that resolves with the user's choice.
   * Opens the modal and waits for the user to either confirm or cancel.
   *
   * @return {Promise<boolean>} Promise that resolves to true if confirmed, false if canceled
   */
  public async confirm(): Promise<boolean> {
    return new Promise((resolve: (value: boolean) => void): void => {
      this.resolvePromise = resolve;
      this.open();
    });
  }
}
