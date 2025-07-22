import { ObsidianEvent } from '@/consts';
import { BaseEvent } from '@/events/base.event';
import type { ObsidianEventName } from '@/types';

/**
 * Event handler for Obsidian's editor change event.
 * Triggers when changes occur in the editor.
 * Currently inactive (handler implementation is commented out).
 *
 * @extends {BaseEvent}
 */
export class WorkspaceEditorChangeEvent extends BaseEvent {
  /**
   * The name of the Obsidian event to handle.
   * Set to the workspace.editorChange event.
   */
  public name: ObsidianEventName = ObsidianEvent.workspace.editorChange;

  /**
   * Handles the editor change event.
   * Currently, does not perform any actions (implementation is commented out).
   */
  public handler(): void {
    // currently not in use
  };
}
