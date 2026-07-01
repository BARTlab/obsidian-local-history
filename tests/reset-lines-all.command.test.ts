import 'reflect-metadata';
import { describe, expect, it, jest } from '@jest/globals';

import { ResetLinesAllCommand } from '@/commands/reset-lines-all.command';
import type { SnapshotsService } from '@/services/snapshots.service';
import { TOKENS } from '@/services/tokens';
import * as obsidian from 'obsidian';

type PluginArg = ConstructorParameters<typeof ResetLinesAllCommand>[0];

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
 * Builds a ResetLinesAllCommand over a container-shaped plugin stub whose
 * @Inject snapshots field resolves to a mock recording the single mutating call
 * (wipe) the command delegates to.
 */
const makeContext = (): {
  command: ResetLinesAllCommand;
  snapshots: { wipe: jest.Mock; wipeOne: jest.Mock };
} => {
  const snapshots = { wipe: jest.fn(), wipeOne: jest.fn() };

  const container: Map<unknown, unknown> = new Map<unknown, unknown>([
    [TOKENS.snapshots, snapshots as unknown as SnapshotsService],
  ]);

  const plugin = {
    get: (key: unknown): unknown => container.get(key),
    t: (key: string): string => key,
  } as unknown as PluginArg;

  return { command: new ResetLinesAllCommand(plugin), snapshots };
};

describe('ResetLinesAllCommand', () => {
  it('declares its command id and localized name (registration metadata)', () => {
    const { command } = makeContext();

    expect(command.id).toBe('tracker-reset-lines-all');
    expect(command.name).toBe('command.reset-lines-all');
  });

  it('wipes every snapshot and shows a notice', () => {
    const notice = spyNotice();
    const { command, snapshots } = makeContext();

    // This command is a plain (non-editor) callback, so it runs without an
    // active editor and clears the whole store rather than one file.
    command.callback();

    expect(snapshots.wipe).toHaveBeenCalledTimes(1);
    expect(snapshots.wipeOne).not.toHaveBeenCalled();
    expect(notice).toHaveBeenCalledWith('notice.all-snapshots-deleted');

    notice.mockRestore();
  });
});
