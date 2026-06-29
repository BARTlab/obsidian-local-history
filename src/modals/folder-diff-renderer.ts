import { DEFAULT_LINE_BREAK, DiffOutputFormatType, FolderDeltaStatus } from '@/consts';
import { assertNever } from '@/helpers/assert-never.helper';
import { DiffRenderHelper } from '@/helpers/diff-render.helper';
import { DomHelper } from '@/helpers/dom.helper';
import { FolderDeltaHelper } from '@/helpers/folder-delta.helper';
import { DiffHeaderController } from '@/modals/diff-header-controller';
import type LineChangeTrackerPlugin from '@/main';
import type { FileSnapshot } from '@/snapshots/file.snapshot';
import type { DiffRenderMode, FolderDeltaResult } from '@/types';

/**
 * Host port the {@link FolderDiffRenderer} reads its shared modal state through.
 * The renderer owns the diff pane (the diff body, the above-diff notice, and the
 * side-by-side column header) but stays stateless about the modal: it reads the
 * live containers, the selected display mode, the selected timeline point T, the
 * tree's selected file, and the snapshot map back through this port. After every
 * render it calls {@link onDiffRendered} so the host can re-sync concerns it
 * still owns (the toolbar action-button states), keeping the diff renderer free
 * of any toolbar coupling.
 */
export interface FolderDiffHost {
  /** The plugin instance, used only for translation lookups. */
  readonly plugin: LineChangeTrackerPlugin;

  /**
   * The diff body container, or `undefined` before the shell is built. The
   * renderer is a no-op when it is absent.
   *
   * @return {HTMLElement | undefined} The diff container, or undefined
   */
  diffContainerEl(): HTMLElement | undefined;

  /**
   * The above-diff notice container, or `undefined` before the shell is built.
   *
   * @return {HTMLElement | undefined} The notice container, or undefined
   */
  noticeEl(): HTMLElement | undefined;

  /**
   * The side-by-side column header container, or `undefined` before the shell
   * is built.
   *
   * @return {HTMLElement | undefined} The columns header container, or undefined
   */
  columnsHeaderEl(): HTMLElement | undefined;

  /**
   * The currently selected display mode, used to choose the diff layout and to
   * decide whether the side-by-side column header is shown.
   *
   * @return {DiffRenderMode} The selected display mode
   */
  displayMode(): DiffRenderMode;

  /**
   * The currently selected timeline point T in ms: the diff base, the notice,
   * and the left column header all read against it.
   *
   * @return {number} The selected T
   */
  selectedTimestamp(): number;

  /**
   * The vault-relative path of the file currently focused in the tree, or
   * `null` when nothing is selected.
   *
   * @return {string | null} The selected file path, or null
   */
  selectedPath(): string | null;

  /**
   * The snapshot map keyed by path, used to resolve the selected file back to
   * its snapshot for the per-file delta at T.
   *
   * @return {Map<string, FileSnapshot>} The snapshot map
   */
  snapshotsByPath(): Map<string, FileSnapshot>;

  /**
   * Called after every diff render so the host can re-sync concerns it still
   * owns (the toolbar action-button states), keeping that toolbar logic off the
   * diff renderer.
   */
  onDiffRendered(): void;
}

/**
 * Diff-pane collaborator for the folder-history modal.
 *
 * Extracted from {@link FolderHistoryModal} as a plain object the modal
 * instantiates and owns (per ADR-11: deep collaborators, not DI
 * services). It owns the right-hand diff pane: rendering the per-file delta at
 * the selected timeline point T through the shared {@link DiffRenderHelper},
 * the above-diff notice (added / deleted / unchanged / no-file hints), and the
 * side-by-side column header. It is stateless about the modal and reads the
 * live containers, the selected display mode, the selected T, the tree's
 * selected file, and the snapshot map back through {@link FolderDiffHost},
 * signalling each render via the host's `onDiffRendered` so the modal keeps
 * coordinating the toolbar action-button states.
 */
export class FolderDiffRenderer {
  /**
   * Diff-header collaborator shared with the file modal: it owns the reveal /
   * hide DOM mechanics for the above-diff notice and the side-by-side column
   * header, so the two modals cannot drift. This renderer keeps the
   * folder-specific decisions (which notice text, whether the header shows, its
   * left label) and feeds the resolved values in.
   */
  protected readonly header: DiffHeaderController;

  /**
   * @param {FolderDiffHost} host - The modal port the renderer reads its shared
   *   state through and reports each render back to.
   */
  public constructor(protected readonly host: FolderDiffHost) {
    this.header = new DiffHeaderController(
      (): HTMLElement | undefined => this.host.noticeEl(),
      (): HTMLElement | undefined => this.host.columnsHeaderEl(),
      this.host.plugin,
    );
  }

  /**
   * Renders the diff for the currently-selected file at the currently-selected
   * T. When no file is selected (an empty tree, or every entry filtered to
   * status `'none'` at this T) the diff pane is replaced with a calm hint
   * instead of leaving stale content on screen. After laying out the notice and
   * column header it calls back into the host so the toolbar action-button
   * states stay in sync with the visible selection.
   */
  public refresh(): void {
    const diffContainerEl: HTMLElement | undefined = this.host.diffContainerEl();

    if (!diffContainerEl) {
      return;
    }

    const path: string | null = this.host.selectedPath();
    const snapshot: FileSnapshot | undefined = path ? this.host.snapshotsByPath().get(path) : undefined;
    const result: FolderDeltaResult | null = snapshot
      ? FolderDeltaHelper.compareAt(snapshot, this.host.selectedTimestamp())
      : null;

    this.updateNotice(result);
    this.updateColumnsHeader(result);
    this.host.onDiffRendered();

    if (!result) {
      DomHelper.update(diffContainerEl, { text: '' });

      return;
    }

    DiffRenderHelper.render({
      baseLines: result.base,
      currentLines: result.current,
      lineBreak: snapshot?.content.lineBreak ?? DEFAULT_LINE_BREAK,
      mode: this.host.displayMode(),
      container: diffContainerEl,
      filePath: path ?? '',
      plugin: this.host.plugin,
    });
  }

  /**
   * Shows or hides the above-diff notice based on the selected file's status
   * at T. The notice is shown when there is no file to diff (empty tree at T),
   * when the file did not change (`'none'`), or for added / deleted variants
   * the user benefits from a one-line explanation alongside the
   * "everything green / red" diff.
   *
   * @param {FolderDeltaResult | null} result - The compareAt result for the selected file
   */
  protected updateNotice(result: FolderDeltaResult | null): void {
    this.header.updateNotice(this.resolveNoticeText(result));
  }

  /**
   * Picks the inline-English notice text for the selected file's status, or
   * null when no banner is needed (status `'modified'` reads on its own).
   * The literal strings are propagated across every catalog.
   *
   * @param {FolderDeltaResult | null} result - The compareAt result
   * @return {string | null} The notice text or null when the banner is hidden
   */
  protected resolveNoticeText(result: FolderDeltaResult | null): string | null {
    if (!result) {
      return this.host.plugin.t('modal.folder.notice.no-file');
    }

    switch (result.status) {
      case FolderDeltaStatus.added:
        return this.host.plugin.t('modal.folder.notice.added');
      case FolderDeltaStatus.deleted:
        return this.host.plugin.t('modal.folder.notice.deleted');
      case FolderDeltaStatus.none:
        return this.host.plugin.t('modal.folder.notice.unchanged');
      case FolderDeltaStatus.modified:
        return null;
      default:
        return assertNever(result.status, 'folder delta status');
    }
  }

  /**
   * Toggles the side-by-side column header and, when shown, labels the left
   * column with the picked timeline point and the right column with the
   * current state. Hidden in the single-column modes (patch / inline /
   * line-by-line).
   *
   * @param {FolderDeltaResult | null} result - The compareAt result for the selected file
   */
  protected updateColumnsHeader(result: FolderDeltaResult | null): void {
    const sideBySide: boolean = this.host.displayMode() === DiffOutputFormatType.side;
    const pointLabel: string | null =
      sideBySide && result ? new Date(this.host.selectedTimestamp()).toLocaleString() : null;

    this.header.updateColumnsHeader(pointLabel);
  }
}
