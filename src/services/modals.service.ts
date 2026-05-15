import { Inject } from '@/decorators/inject.decorator';
import { type SelectableVersion, SelectionHistoryHelper } from '@/helpers/selection-history.helper';
import type LineChangeTrackerPlugin from '@/main';
import { ConfirmModal } from '@/modals/confirm.modal';
import { HistoryModal } from '@/modals/history.modal';
import { PromptModal } from '@/modals/prompt.modal';
import type { SnapshotsService } from '@/services/snapshots.service';
import type { VersionActionsService } from '@/services/version-actions.service';
import type { FileSnapshot } from '@/snapshots/file.snapshot';
import type { FileVersion } from '@/snapshots/file.version';
import type { ConfirmModalConfig, PromptModalConfig, Service } from '@/types';
import type { TFile } from 'obsidian';

/**
 * Open options for the history/diff modal. Both fields are optional, so a call
 * with no options preserves the current default behaviour: the rail is shown
 * and the modal opens on the latest captured version (D4).
 *
 * - `initialBaseId`: pre-selects a specific version id as the diff base on open
 *   (the rail entry that would otherwise be the top one). A baseline-only file
 *   ignores it; an unknown id falls through to the modal's default selection.
 * - `hideRail`: opens the modal without the left rail (search + version list),
 *   so the diff and the toolbar fill the modal. Used by the Recent changes
 *   panel, which is the navigator in that session.
 */
export interface HistoryModalOpenOptions {
  /** The version id to pre-select as the diff base on open */
  initialBaseId?: string;
  /** Whether to hide the left rail (search + version list) */
  hideRail?: boolean;
  /**
   * Optional set of version ids the rail must restrict itself to: when present,
   * only versions whose id is in the set survive the rail filters. Used by
   * "Show History for Selection" (D7/T09) to narrow the rail to versions where
   * the editor selection was added or removed. `undefined` means no selection
   * filter is active (the rail behaves as before); an empty set means a filter
   * is active but matched nothing, so the rail shows its no-results hint.
   */
  selectionFilterIds?: ReadonlySet<string>;
}

/**
 * Service responsible for managing modal dialogs in the plugin.
 * Provides methods to open different types of modals, such as diff/history views.
 *
 * @implements {Service}
 */
export class ModalsService implements Service {
  /**
   * Service for managing file snapshots.
   * Injected using the @Inject decorator.
   */
  @Inject('SnapshotsService')
  protected snapshotsService: SnapshotsService;

  /**
   * Service that owns version restore/remove/put-label actions (D5). Wired here
   * so the Put label entry point can prompt for a label and forward the trimmed
   * result to the shared capture path without each call site duplicating the
   * snapshot lookup or the empty/cancel handling.
   */
  @Inject('VersionActionsService')
  protected versionActionsService: VersionActionsService;

  /**
   * Creates a new instance of ModalsService.
   *
   * @param {LineChangeTrackerPlugin} plugin - The plugin instance
   */
  public constructor(
    protected plugin: LineChangeTrackerPlugin,
  ) {
  }

  /**
   * Initializes the service.
   * This method is called during plugin initialization.
   * Currently, it does not perform any initialization actions.
   */
  public init(): void {
  }

  /**
   * Checks whether a diff/history modal can be opened for a file.
   * The modal only carries value when a snapshot exists; this is the predicate a
   * command's `checkCallback` uses to decide if it should be enabled. It does not
   * depend on an active editor, so it is true in reading mode as well, as long as
   * the file (active file by default) has tracked history.
   *
   * @param {TFile} file - The file to check, or null to use the active file
   * @return {boolean} True if a snapshot exists and the modal can be opened
   */
  public canDiff(file?: TFile | null): boolean {
    return this.snapshotsService.getOne(file) !== null;
  }

  /**
   * Opens a diff/history modal for a file.
   * Retrieves the file snapshot and opens a HistoryModal if the snapshot exists.
   * The modal itself is editor-independent, so it opens the same way in reading
   * (preview) mode as in source mode; only the inline line highlights are
   * editor-only.
   *
   * Optional open options (D4) let a caller pre-select a specific base version
   * and hide the left rail. With no options the modal behaves exactly as
   * before: the rail is visible and the latest captured version is selected.
   *
   * @param {TFile} file - The file to show diff for, or null to use the active file
   * @param {HistoryModalOpenOptions} options - Optional open options
   * @return {boolean} True if the modal was opened successfully, false if no snapshot exists
   */
  public diff(file?: TFile | null, options?: HistoryModalOpenOptions): boolean {
    const snapshot: FileSnapshot = this.snapshotsService.getOne(file);

    if (!snapshot) {
      return false;
    }

    new HistoryModal(this.plugin.app, this.plugin, snapshot, options).open();

    return true;
  }

  /**
   * Opens the history modal filtered to versions where the supplied selection
   * text was added or removed at that point on the timeline (D7/T09). The
   * filter is precomputed via the pure SelectionHistoryHelper so the modal
   * just applies the resulting id set as a rail filter.
   *
   * A null/empty/whitespace selection has no precision to offer, so this falls
   * back to the plain Show History path (the normal modal with no selection
   * filter), keeping the entry safe to wire as a generic command without an
   * upstream emptiness gate. A missing snapshot returns false, mirroring
   * `diff`.
   *
   * @param {TFile} file - The file to show diff for, or null to use the active file
   * @param {string} selection - The selection text to filter versions by
   * @return {boolean} True if the modal was opened, false if no snapshot exists
   */
  public diffForSelection(file?: TFile | null, selection?: string | null): boolean {
    const snapshot: FileSnapshot = this.snapshotsService.getOne(file);

    if (!snapshot) {
      return false;
    }

    const needle: string = (selection ?? '').trim();

    if (needle.length === 0) {
      // Empty selection has nothing to filter by; fall back to the plain Show
      // History modal so the entry is a safe no-op rather than an error.
      new HistoryModal(this.plugin.app, this.plugin, snapshot).open();

      return true;
    }

    // SelectionHistoryHelper expects versions oldest-first; getVersions() is
    // newest-first, so reverse before handing them off.
    const selectable: SelectableVersion[] = snapshot
      .getVersions()
      .slice()
      .reverse()
      .map((version: FileVersion): SelectableVersion => ({
        id: version.id,
        lines: version.getLines(),
      }));

    const matched: Set<string> = SelectionHistoryHelper.match(
      selectable,
      snapshot.getHistoryOriginalStateLines(),
      needle,
    );

    new HistoryModal(this.plugin.app, this.plugin, snapshot, { selectionFilterIds: matched }).open();

    return true;
  }

  /**
   * Shows a confirmation dialog with the specified configuration.
   * Creates a ConfirmModal instance and returns a promise that resolves with the user's choice.
   *
   * @param {ConfirmModalConfig} config - Configuration object for the confirmation dialog
   * @return {Promise<boolean>} Promise that resolves to true if confirmed, false if cancelled
   */
  public async confirm(config: ConfirmModalConfig): Promise<boolean> {
    const modal: ConfirmModal = new ConfirmModal(this.plugin.app, config);

    return await modal.confirm();
  }

  /**
   * Shows a single-input prompt dialog with the specified configuration (D8).
   * Creates a PromptModal instance and returns a promise that resolves to the
   * entered text, or `null` when the user cancels or otherwise closes the
   * modal without confirming. Used by "Put label" to collect a free-text
   * version tag.
   *
   * @param {PromptModalConfig} config - Configuration object for the prompt dialog
   * @return {Promise<string | null>} Promise that resolves to the entered text or null on cancel
   */
  public async prompt(config: PromptModalConfig): Promise<string | null> {
    const modal: PromptModal = new PromptModal(this.plugin.app, config);

    return await modal.prompt();
  }

  /**
   * Captures a pinned labeled version of the file's current content by first
   * asking the user for a label through the PromptModal (D8) and then handing
   * the trimmed result to VersionActionsService.putLabel (D6). A cancelled
   * prompt or an empty/whitespace label is a silent no-op so the user can back
   * out without polluting the timeline; a missing snapshot is also a no-op so
   * an untracked file does not surface a confusing error.
   *
   * Both gates (cancel and blank) are normalized to the same null path the
   * service treats as a no-op, so the call site never has to repeat the trim.
   * Returns the captured version on success and null on any no-op, mirroring
   * the underlying service contract.
   *
   * @param {TFile} file - The file to label, or null to use the active file
   * @param {PromptModalConfig} configOverride - Optional overrides for the prompt strings
   * @return {Promise<FileVersion | null>} The captured version, or null on a no-op
   */
  public async putLabel(
    file?: TFile | null,
    configOverride?: PromptModalConfig,
  ): Promise<FileVersion | null> {
    const target: TFile | null = file ?? this.plugin.getActiveFile();

    // Bail before the prompt when no snapshot exists, so an untracked file does
    // not pop a modal whose confirm would silently fail. The submenu gates this
    // upstream too, but the service stays safe on a direct call.
    if (!this.snapshotsService.getOne(target)) {
      return null;
    }

    const config: PromptModalConfig = {
      title: this.plugin.t('modal.put-label.title'),
      message: this.plugin.t('modal.put-label.message'),
      placeholder: this.plugin.t('modal.put-label.placeholder'),
      confirmText: this.plugin.t('modal.put-label.confirm'),
      cancelText: this.plugin.t('modal.confirm.cancel'),
      ...configOverride,
    };

    const entered: string | null = await this.prompt(config);

    // A cancel returns null; a blank confirm is treated as the same no-op so
    // the user does not accidentally pin a meaningless empty marker. The
    // service re-trims defensively, but normalizing here keeps the contract
    // explicit at the entry point.
    if (entered === null || entered.trim().length === 0) {
      return null;
    }

    return this.versionActionsService.putLabel(target, entered);
  }

  /**
   * Labels an EXISTING captured version: asks for a tag through the PromptModal
   * (D8) and forwards the trimmed result to
   * VersionActionsService.labelVersion. Unlike {@link putLabel}, which pins the
   * file's CURRENT content as a new version, this marks the version the caller
   * picked (a Recent changes row, or the modal's selected base), so the label
   * lands on the slice the user pointed at instead of on the latest state. The
   * prompt is pre-filled with the version's current label so an existing marker
   * can be edited rather than retyped. A cancel or a blank/whitespace input is
   * a silent no-op; a missing snapshot or an unknown version id is a no-op too.
   *
   * @param {TFile} file - The file the version belongs to, or null for the active file
   * @param {string} versionId - The id of the existing version to label
   * @param {PromptModalConfig} configOverride - Optional overrides for the prompt strings
   * @return {Promise<FileVersion | null>} The labeled version, or null on a no-op
   */
  public async labelVersion(
    file: TFile | null,
    versionId: string,
    configOverride?: PromptModalConfig,
  ): Promise<FileVersion | null> {
    const target: TFile | null = file ?? this.plugin.getActiveFile();
    const snapshot: FileSnapshot | null = this.snapshotsService.getOne(target);

    if (!snapshot) {
      return null;
    }

    const existing: FileVersion | null = snapshot.getVersion(versionId);

    if (!existing) {
      return null;
    }

    const config: PromptModalConfig = {
      title: this.plugin.t('modal.put-label.title'),
      message: this.plugin.t('modal.label-version.message'),
      placeholder: this.plugin.t('modal.put-label.placeholder'),
      initialValue: existing.isLabeled() ? (existing.label as string) : '',
      confirmText: this.plugin.t('modal.put-label.confirm'),
      cancelText: this.plugin.t('modal.confirm.cancel'),
      ...configOverride,
    };

    const entered: string | null = await this.prompt(config);

    // Same cancel/blank no-op contract as putLabel: a user backing out must not
    // wipe or alter the version's existing label.
    if (entered === null || entered.trim().length === 0) {
      return null;
    }

    return this.versionActionsService.labelVersion(target, versionId, entered);
  }
}
