import 'reflect-metadata';
import { describe, expect, it } from '@jest/globals';
import { ShowDiffCommand } from '@/commands/show-diff.command';

type PluginArg = ConstructorParameters<typeof ShowDiffCommand>[0];

/**
 * Minimal ModalsService double exposing only the two methods ShowDiffCommand
 * touches. `canDiff` reports availability (a snapshot exists), `diff` opens the
 * modal and reports success; both record their calls so the test can assert the
 * command gated and ran correctly.
 */
class ModalsServiceDouble {
  public diffCalls: number = 0;

  public constructor(
    protected snapshotExists: boolean,
  ) {
  }

  public canDiff(): boolean {
    return this.snapshotExists;
  }

  public diff(): boolean {
    this.diffCalls += 1;

    return this.snapshotExists;
  }
}

/**
 * Builds a ShowDiffCommand wired to a plugin stub whose DI container returns the
 * given ModalsService double, so the command's checkCallback can be exercised
 * without a real container or an Obsidian runtime.
 */
const makeCommand = (modals: ModalsServiceDouble): ShowDiffCommand => {
  const plugin = {
    get: (): unknown => modals,
    t: (key: string): string => key,
  } as unknown as PluginArg;

  return new ShowDiffCommand(plugin);
};

/**
 * Tests for the reading-mode entry point (T5.7). ShowDiffCommand uses a
 * checkCallback so it is available whenever the active file has a snapshot,
 * independent of an editor (hence available in reading mode). The guarantees:
 * - availability mirrors whether a snapshot exists,
 * - querying availability (checking=true) never opens the modal, and
 * - running it (checking=false) opens the modal and reports success.
 */
describe('ShowDiffCommand.checkCallback', () => {
  it('is available when the active file has a snapshot', () => {
    const modals = new ModalsServiceDouble(true);
    const command = makeCommand(modals);

    expect(command.checkCallback(true)).toBe(true);
    // Querying availability must not open the modal.
    expect(modals.diffCalls).toBe(0);
  });

  it('is unavailable when the active file has no snapshot', () => {
    const modals = new ModalsServiceDouble(false);
    const command = makeCommand(modals);

    expect(command.checkCallback(true)).toBe(false);
    expect(modals.diffCalls).toBe(0);
  });

  it('opens the modal when invoked for real and reports success', () => {
    const modals = new ModalsServiceDouble(true);
    const command = makeCommand(modals);

    expect(command.checkCallback(false)).toBe(true);
    expect(modals.diffCalls).toBe(1);
  });

  it('reports failure when invoked with no snapshot available', () => {
    const modals = new ModalsServiceDouble(false);
    const command = makeCommand(modals);

    expect(command.checkCallback(false)).toBe(false);
  });
});
