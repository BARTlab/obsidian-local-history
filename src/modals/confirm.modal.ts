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
  private result: boolean = false;

  /**
   * Promise resolver function to return the user's choice.
   * Called when the modal is closed.
   */
  private resolvePromise: ((value: boolean) => void) | undefined;

  /**
   * The title text displayed in the modal header.
   */
  private readonly title: string;

  /**
   * The message text displayed in the modal body.
   */
  private readonly message: string;

  /**
   * The text displayed on the confirmation button.
   */
  private readonly confirmText: string;

  /**
   * The text displayed on the cancel button.
   */
  private readonly cancelText: string;

  /**
   * Creates a new instance of ConfirmModal.
   *
   * @param {App} app - The Obsidian app instance
   * @param {ConfirmModalConfig} config - Configuration object for the modal
   */
  public constructor(
    app: App,
    config: ConfirmModalConfig
  ) {
    super(app);

    this.title = config.title ?? 'Confirmation';
    this.message = config.message ?? 'Are you sure you want to proceed?';
    this.confirmText = config.confirmText ?? 'Confirm';
    this.cancelText = config.cancelText ?? 'Cancel';
  }

  /**
   * Called when the modal is opened.
   * Creates the modal content with title, message, and action buttons.
   * Sets up event handlers for the buttons and focused the confirmation button.
   *
   * @override
   */
  public onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    DomHelper.create({
      tag: 'div',
      container: contentEl,
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
          styles: {
            display: 'flex',
            justifyContent: 'flex-end',
            gap: '10px',
            marginTop: '20px'
          },
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
    });

    // Focus the confirmation button
    const confirmButton = contentEl.querySelector('button.mod-warning') as HTMLButtonElement;

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
