import type LineChangeTrackerPlugin from '@/main';
import type { Command } from 'obsidian';

/**
 * Command that reveals the vault-wide changes panel in the right sidebar.
 *
 * Uses a plain `callback` (not `checkCallback`): the panel is vault-wide and
 * useful regardless of the active file or view mode, so it is always available.
 * Reusing an existing leaf is handled by `plugin.revealVaultChanges`, so
 * repeated invocations focus the panel instead of spawning duplicates.
 *
 * @implements {Command}
 */
export class OpenVaultChangesCommand implements Command {
  /** Unique identifier Obsidian registers and references the command by. */
  public id: string = 'tracker-open-vault-changes';

  /** Display name shown in the command palette, localized. */
  public name: string = this.plugin.t('command.open-vault-changes');

  public constructor(
    public plugin: LineChangeTrackerPlugin,
  ) {
  }

  /**
   * Reveals (or focuses) the vault-wide changes panel.
   *
   * @return {void}
   */
  public callback = (): void => {
    void this.plugin.revealVaultChanges();
  };
}
