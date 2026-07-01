import type { VersionList } from '@/components/version-list.component';

/**
 * Host port the {@link KeyboardController} reads its shared modal state through.
 * The controller owns the keydown behaviour but stays stateless about the modal:
 * it walks the version rail through the owned {@link VersionList}, reads the live
 * diff container back to resolve the active scroller, and routes the confirm-
 * before-delete flow back to the modal.
 */
export interface KeyboardControllerHost {
  /** The version-list collaborator whose selection the rail keys walk. */
  readonly versionList: VersionList;

  /**
   * The rendered diff container, or `undefined` before the first render. The
   * diff-pane keys are a no-op when it is absent.
   *
   * @return {HTMLElement | undefined} The diff container, or undefined
   */
  diffContainer(): HTMLElement | undefined;

  /**
   * Runs the confirm-before-delete flow for the selected version, then returns
   * focus to the list. The modal owns the confirm dialog and the deletion.
   */
  confirmRemoveSelectedVersion(): void;
}
