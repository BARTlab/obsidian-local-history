import { DomHelper } from '@/helpers/dom.helper';
import type { PromptModalConfig } from '@/types';
import { type App, Modal } from 'obsidian';

/**
 * Single-input prompt modal for short free-text capture.
 *
 * Asks the user for one short string (for example a custom version label),
 * resolves to the entered text on confirm, and resolves to `null` on cancel
 * or any other close path (Escape, clicking outside, programmatic close). The
 * keyboard ergonomics match ConfirmModal: Enter inside the input confirms.
 *
 * The modal does not trim or otherwise post-process the entered value: the
 * caller is free to decide what counts as empty (the label flow treats blank/whitespace as
 * a cancel), keeping this modal a thin reusable input layer.
 *
 * @extends {Modal}
 */
export class PromptModal extends Modal {
  /**
   * The text the user entered before confirming, or `null` when the modal was
   * cancelled or closed without confirming. Initialized to `null` so any close
   * path that does not flow through the confirm button resolves to a cancel.
   */
  protected result: string | null = null;

  /**
   * Promise resolver function returning the user's input.
   * Called once during `onClose` with the final `result`.
   */
  protected resolvePromise: ((value: string | null) => void) | undefined;

  /** The title text displayed in the modal header. */
  protected readonly title: string;

  /**
   * Optional message text displayed above the input. Empty by default and not
   * rendered when blank.
   */
  protected readonly message: string;

  /** Placeholder text shown inside the empty input. */
  protected readonly placeholder: string;

  /** Value pre-filled in the input on open. */
  protected readonly initialValue: string;

  /** The text displayed on the confirmation button. */
  protected readonly confirmText: string;

  /** The text displayed on the cancel button. */
  protected readonly cancelText: string;

  /**
   * The input element backing the prompt. Kept as a field so `onClose` can read
   * the latest value and the open path can focus it.
   */
  protected inputEl: HTMLInputElement | undefined;

  /**
   * Creates a new instance of PromptModal.
   *
   * @param {App} app - The Obsidian app instance
   * @param {PromptModalConfig} config - Configuration object for the modal
   */
  public constructor(
    app: App,
    config: PromptModalConfig
  ) {
    super(app);

    this.title = config.title ?? 'Prompt';
    this.message = config.message ?? '';
    this.placeholder = config.placeholder ?? '';
    this.initialValue = config.initialValue ?? '';
    this.confirmText = config.confirmText ?? 'Confirm';
    this.cancelText = config.cancelText ?? 'Cancel';
  }

  /**
   * Called when the modal is opened.
   * Builds the modal content with title, optional message, a text input, and
   * action buttons. Wires Enter inside the input to the confirm path so the
   * keyboard ergonomics match ConfirmModal.
   *
   * @override
   */
  public onOpen(): void {
    /**
     * Tag the modal so the stylesheet can mirror the confirm modal's padding;
     * a bare Modal's content otherwise sits flush against the edges.
     */
    DomHelper.update(this.modalEl, { classes: { add: 'lct-prompt-modal' } });

    DomHelper.update(this.contentEl, {
      children: [
        {
          tag: 'div',
          children: [
            {
              tag: 'h2',
              text: this.title
            },
            ...(this.message
              ? [{ tag: 'p' as const, text: this.message }]
              : []),
            {
              tag: 'input',
              classes: 'lct-prompt-input',
              attributes: {
                type: 'text',
                placeholder: this.placeholder,
                value: this.initialValue,
              },
              events: {
                keydown: (event: Event): void => {
                  const keyboard: KeyboardEvent = event as KeyboardEvent;

                  if (keyboard.key === 'Enter') {
                    keyboard.preventDefault();
                    this.confirmResult();
                  }
                }
              }
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
                      this.result = null;
                      this.close();
                    }
                  }
                },
                {
                  tag: 'button',
                  text: this.confirmText,
                  classes: 'mod-cta',
                  events: {
                    click: (): void => this.confirmResult()
                  }
                }
              ]
            }
          ]
        }
      ]
    });

    this.inputEl = this.contentEl.querySelector('input.lct-prompt-input') as HTMLInputElement;

    /**
     * Apply the initial value via the property, so submission reads the latest
     * user-edited string without depending on the attribute being kept in sync.
     */
    if (this.inputEl) {
      this.inputEl.value = this.initialValue;
      this.inputEl.focus();
      this.inputEl.select();
    }
  }

  /**
   * Called when the modal is closed.
   * Resolves the prompt promise with the captured `result` (the entered text
   * on confirm, `null` on cancel or any non-confirm close path).
   *
   * @override
   */
  public onClose(): void {
    if (this.resolvePromise) {
      this.resolvePromise(this.result);
    }
  }

  /**
   * Opens the modal and returns a promise that resolves to the entered text
   * on confirm, or `null` on cancel/close.
   *
   * @return {Promise<string | null>} Promise that resolves to the entered text or null
   */
  public async prompt(): Promise<string | null> {
    return new Promise((resolve: (value: string | null) => void): void => {
      this.resolvePromise = resolve;
      this.open();
    });
  }

  /**
   * Snapshots the current input value as the result and closes the modal.
   * Shared by the confirm button click and the Enter keydown so both paths
   * land in onClose with the same `result`.
   */
  protected confirmResult(): void {
    this.result = this.inputEl ? this.inputEl.value : '';
    this.close();
  }
}
