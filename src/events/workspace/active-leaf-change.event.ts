import { ObsidianEvent } from '@/consts';
import { Inject } from '@/decorators/inject.decorator';
import { BaseEvent } from '@/events/base.event';
import type { SnapshotsService } from '@/services/snapshots.service';
import type { ObsidianEventName, WorkspaceEventArgs } from '@/types';

/**
 * Event handler for Obsidian's active leaf change event.
 * Triggers when the user switches between different panes or views.
 * Forces an update of the snapshot service to ensure the plugin's state is current.
 *
 * @extends {BaseEvent}
 */
export class WorkspaceActiveLeafChangeEvent extends BaseEvent {
  /**
   * Service for managing file snapshots.
   * Injected using the @Inject decorator.
   */
  @Inject('SnapshotsService')
  protected snapshotsService: SnapshotsService;

  /**
   * The name of the Obsidian event to handle.
   * Set to the workspace.activeLeafChange event.
   */
  public readonly name: ObsidianEventName = ObsidianEvent.workspace.activeLeafChange;

  /**
   * Handles the active leaf change event.
   * Forces an update of the snapshots to ensure they reflect the current state.
   *
   * @param {...any} args - Arguments passed by the event (not used in this handler)
   */
  public handler(...args: WorkspaceEventArgs<typeof ObsidianEvent.workspace.activeLeafChange>): void {
    const [] = args;

    this.snapshotsService.forceUpdate();
  };
}
