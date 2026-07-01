import 'reflect-metadata';
import { describe, expect, it, jest } from '@jest/globals';

import { WorkspaceFileOpenEvent } from '@/events/workspace/file-open.event';
import type LineChangeTrackerPlugin from '@/main';
import type { SnapshotsService } from '@/services/snapshots.service';
import { TOKENS } from '@/services/tokens';
import type { TFile } from 'obsidian';

import { makeTFile as makeFile } from './helpers/builders';

/**
 * Builds a WorkspaceFileOpenEvent over a container-shaped plugin stub whose
 * @Inject snapshots field resolves to a mock recording capture (which the
 * handler fires-and-forgets, so the mock returns a resolved promise).
 */
const makeContext = (): {
  event: WorkspaceFileOpenEvent;
  snapshots: { capture: jest.Mock };
} => {
  const snapshots = { capture: jest.fn().mockReturnValue(Promise.resolve()) };

  const container: Map<unknown, unknown> = new Map<unknown, unknown>([
    [TOKENS.snapshots, snapshots as unknown as SnapshotsService],
  ]);

  const plugin = {
    get: (key: unknown): unknown => container.get(key),
  } as unknown as LineChangeTrackerPlugin;

  return { event: new WorkspaceFileOpenEvent(plugin), snapshots };
};

describe('WorkspaceFileOpenEvent', () => {
  it('declares the workspace.file-open event name', () => {
    const { event } = makeContext();

    expect(event.name).toBe('workspace.file-open');
  });

  it('captures a baseline snapshot of the opened file', () => {
    const { event, snapshots } = makeContext();
    const file: TFile = makeFile('notes/a.md');

    event.handler(file);

    expect(snapshots.capture).toHaveBeenCalledTimes(1);
    expect(snapshots.capture).toHaveBeenCalledWith(file);
  });

  it('short-circuits when no file is provided (null)', () => {
    const { event, snapshots } = makeContext();

    event.handler(null);

    expect(snapshots.capture).not.toHaveBeenCalled();
  });
});
