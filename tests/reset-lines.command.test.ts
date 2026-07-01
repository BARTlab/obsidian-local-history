import 'reflect-metadata';
import { describe, expect, it, jest } from '@jest/globals';

import { ResetLinesCommand } from '@/commands/reset-lines.command';
import type { SnapshotsService } from '@/services/snapshots.service';
import { TOKENS } from '@/services/tokens';
import * as obsidian from 'obsidian';

type PluginArg = ConstructorParameters<typeof ResetLinesCommand>[0];

/**
 * Spies on the obsidian Notice constructor with an inert implementation, so
 * `new Notice(...)` is counted without standing up a real toast (spying on an
 * ES6 class without a mock implementation throws on `new`).
 */
const spyNotice = (): jest.SpiedClass<typeof obsidian.Notice> =>
  jest.spyOn(obsidian, 'Notice').mockImplementation(
    (function(this: unknown): void {
      // Inert: record the construction only.
    }) as unknown as (message?: string | DocumentFragment) => obsidian.Notice,
  );

/**
 * Builds a ResetLinesCommand over a container-shaped plugin stub whose @Inject
 * snapshots field resolves to a mock recording the single mutating call
 * (wipeOne) the command delegates to.
 */
const makeContext = (): {
  command: ResetLinesCommand;
  snapshots: { wipeOne: jest.Mock; wipe: jest.Mock };
} => {
  const snapshots = { wipeOne: jest.fn(), wipe: jest.fn() };

  const container: Map<unknown, unknown> = new Map<unknown, unknown>([
    [TOKENS.snapshots, snapshots as unknown as SnapshotsService],
  ]);

  const plugin = {
    get: (key: unknown): unknown => container.get(key),
    t: (key: string): string => key,
  } as unknown as PluginArg;

  return { command: new ResetLinesCommand(plugin), snapshots };
};

describe('ResetLinesCommand', () => {
  it('declares its command id and localized name (registration metadata)', () => {
    const { command } = makeContext();

    expect(command.id).toBe('tracker-reset-lines');
    expect(command.name).toBe('command.reset-lines');
  });

  it('wipes only the current-document snapshot and shows a notice', () => {
    const notice = spyNotice();
    const { command, snapshots } = makeContext();

    // Declared as a zero-arg editorCallback: it always targets the current
    // file's snapshot rather than any editor Obsidian would pass.
    command.editorCallback();

    expect(snapshots.wipeOne).toHaveBeenCalledTimes(1);
    expect(snapshots.wipe).not.toHaveBeenCalled();
    expect(notice).toHaveBeenCalledWith('notice.current-snapshot-deleted');

    notice.mockRestore();
  });
});
