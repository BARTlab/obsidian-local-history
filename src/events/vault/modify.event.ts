import { ObsidianEvent } from '@/consts';
import { BaseEvent } from '@/events/base.event';
import type { ObsidianEventName, VaultEventArgs } from '@/types';

/**
 * Event handler for Obsidian's vault modify event.
 * Responds to file modifications in the vault.
 * Currently, processes front matter but don't perform any actions with it.
 * Contains commented-out debug functionality.
 *
 * @extends {BaseEvent}
 */
export class VaultModifyEvent extends BaseEvent {
  /**
   * The name of the Obsidian event to handle.
   * Set to the vault.modify event.
   */
  public readonly name: ObsidianEventName = ObsidianEvent.vault.modify;

  /**
   * Handles the vault modify event.
   * Processes the front matter of the modified file.
   * Currently, doesn't perform any actions with the processed front matter.
   *
   * @param {...any} _args - Arguments passed by the event, containing the modified file
   */
  public handler(..._args: VaultEventArgs<typeof ObsidianEvent.vault.modify>): void {
    // currently not in use
  };
}
