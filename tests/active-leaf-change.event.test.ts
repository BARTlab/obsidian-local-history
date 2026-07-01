import 'reflect-metadata';
import { describe, expect, it, jest } from '@jest/globals';

import { WorkspaceActiveLeafChangeEvent } from '@/events/workspace/active-leaf-change.event';
import type LineChangeTrackerPlugin from '@/main';
import type { SnapshotsService } from '@/services/snapshots.service';
import { TOKENS } from '@/services/tokens';

/**
 * Builds a WorkspaceActiveLeafChangeEvent over a container-shaped plugin stub
 * whose @Inject snapshots field resolves to a mock recording forceUpdate, and
 * whose readiness the test controls via `ready`.
 */
const makeContext = (
  ready: boolean,
): {
  event: WorkspaceActiveLeafChangeEvent;
  snapshots: { forceUpdate: jest.Mock };
} => {
  const snapshots = { forceUpdate: jest.fn() };

  const container: Map<unknown, unknown> = new Map<unknown, unknown>([
    [TOKENS.snapshots, snapshots as unknown as SnapshotsService],
  ]);

  const plugin = {
    get: (key: unknown): unknown => container.get(key),
    isReady: (): boolean => ready,
  } as unknown as LineChangeTrackerPlugin;

  return { event: new WorkspaceActiveLeafChangeEvent(plugin), snapshots };
};

describe('WorkspaceActiveLeafChangeEvent', () => {
  it('declares the workspace.active-leaf-change event name', () => {
    const { event } = makeContext(true);

    expect(event.name).toBe('workspace.active-leaf-change');
  });

  it('forces a snapshot update when the plugin is ready', () => {
    const { event, snapshots } = makeContext(true);

    event.handler(null);

    expect(snapshots.forceUpdate).toHaveBeenCalledTimes(1);
  });

  it('short-circuits without forcing an update when the plugin is not ready', () => {
    const { event, snapshots } = makeContext(false);

    event.handler(null);

    expect(snapshots.forceUpdate).not.toHaveBeenCalled();
  });
});
