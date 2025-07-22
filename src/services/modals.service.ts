import { Inject } from '@/decorators/inject.decorator';
import type LineChangeTrackerPlugin from '@/main';
import { ConfirmModal } from '@/modals/confirm.modal';
import { HistoryModal } from '@/modals/history.modal';
import type { SnapshotsService } from '@/services/snapshots.service';
import type { FileSnapshot } from '@/snapshots/file.snapshot';
import type { ConfirmModalConfig, Service } from '@/types';
import type { TFile } from 'obsidian';

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
   * Opens a diff/history modal for a file.
   * Retrieves the file snapshot and opens a HistoryModal if the snapshot exists.
   *
   * @param {TFile} file - The file to show diff for, or null to use the active file
   * @return {boolean} True if the modal was opened successfully, false if no snapshot exists
   */
  public diff(file?: TFile | null): boolean {
    const snapshot: FileSnapshot = this.snapshotsService.getOne(file);

    if (!snapshot) {
      return false;
    }

    new HistoryModal(this.plugin.app, this.plugin, snapshot).open();

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
}
