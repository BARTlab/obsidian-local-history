import 'reflect-metadata';
import { describe, expect, it } from '@jest/globals';
import { OpenVaultChangesCommand } from '@/commands/open-vault-changes.command';

type PluginArg = ConstructorParameters<typeof OpenVaultChangesCommand>[0];

/**
 * Minimal plugin double exposing only what OpenVaultChangesCommand touches: the
 * reveal entry point (counted so the test can assert the callback delegated) and
 * the translator (echoing keys so the name assertion is stable without a real
 * catalog).
 */
class PluginDouble {
  public revealCalls: number = 0;

  public revealVaultChanges(): Promise<void> {
    this.revealCalls += 1;

    return Promise.resolve();
  }

  public t(key: string): string {
    return key;
  }
}

/**
 * Builds an OpenVaultChangesCommand over a plugin stub, so the command's id,
 * name, and callback can be exercised without an Obsidian runtime.
 */
const makeCommand = (plugin: PluginDouble): OpenVaultChangesCommand =>
  new OpenVaultChangesCommand(plugin as unknown as PluginArg);

describe('OpenVaultChangesCommand', () => {
  it('exposes the stable id and a localized name', () => {
    const command = makeCommand(new PluginDouble());

    expect(command.id).toBe('tracker-open-vault-changes');
    // The translator echoes the key, so the name resolves through it.
    expect(command.name).toBe('command.open-vault-changes');
  });

  it('reveals the vault changes panel when the callback runs', () => {
    const plugin = new PluginDouble();
    const command = makeCommand(plugin);

    command.callback?.();

    expect(plugin.revealCalls).toBe(1);
  });
});
