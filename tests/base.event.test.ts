import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { BaseEvent } from '@/events/base.event';
import type LineChangeTrackerPlugin from '@/main';
import type { ObsidianEventName } from '@/types';

import { flushMicrotasks } from './helpers/async-utils';

/**
 * Captures the callback registered with a fake Obsidian trigger so the test can
 * dispatch events through the registration wrapping. The trigger imitates
 * the surface BaseEvent.register() reaches: only `on(name, callback, context)`
 * matters here. Returning a sentinel keeps the EventRef contract.
 */
const makeFakeTrigger = (): {
  on: jest.Mock;
  captured: { name?: string; callback?: (...args: unknown[]) => unknown };
} => {
  const captured: { name?: string; callback?: (...args: unknown[]) => unknown } = {};
  const on = jest.fn((name: string, callback: (...args: unknown[]) => unknown): { ref: true } => {
    captured.name = name;
    captured.callback = callback;

    return { ref: true };
  });

  return { on: on as unknown as jest.Mock, captured };
};

const makePlugin = (trigger: { on: jest.Mock }): LineChangeTrackerPlugin => ({
  app: {
    workspace: trigger as unknown,
    vault: trigger as unknown,
  },
}) as unknown as LineChangeTrackerPlugin;

class SyncThrowingEvent extends BaseEvent {
  public readonly name = 'workspace.file-open' as ObsidianEventName;

  public override handler(): void {
    throw new Error('boom-sync');
  }
}

class AsyncRejectingEvent extends BaseEvent {
  public readonly name = 'vault.modify' as ObsidianEventName;

  public override async handler(): Promise<void> {
    throw new Error('boom-async');
  }
}

class HappyEvent extends BaseEvent {
  public readonly name = 'workspace.layout-change' as ObsidianEventName;

  public calls: unknown[][] = [];

  public override handler(...args: unknown[]): void {
    this.calls.push(args);
  }
}

describe('BaseEvent.dispatch', () => {
  let errorSpy: jest.SpiedFunction<typeof console.error>;

  beforeEach(() => {
    errorSpy = jest.spyOn(console, 'error').mockImplementation((): void => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('catches a synchronous throw, logs it, and does not propagate', () => {
    const trigger = makeFakeTrigger();
    const event = new SyncThrowingEvent(makePlugin(trigger));

    event.register();

    expect(trigger.captured.callback).toBeDefined();
    expect((): void => {
      (trigger.captured.callback as (...args: unknown[]) => void)('file');
    }).not.toThrow();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [message, error] = errorSpy.mock.calls[0] as [string, unknown];
    expect(message).toContain('workspace.file-open');
    expect((error as Error).message).toBe('boom-sync');
  });

  it('catches an async rejection and logs it instead of leaving it unhandled', async () => {
    const trigger = makeFakeTrigger();
    const event = new AsyncRejectingEvent(makePlugin(trigger));

    event.register();

    const callback = trigger.captured.callback as (...args: unknown[]) => unknown;
    const returned: unknown = callback('file');

    // The wrapper must not surface the promise to Obsidian (returns void).
    expect(returned).toBeUndefined();

    // Drain the microtask queue so the wrapper's .catch runs deterministically.
    await flushMicrotasks();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [message, error] = errorSpy.mock.calls[0] as [string, unknown];
    expect(message).toContain('vault.modify');
    expect((error as Error).message).toBe('boom-async');
  });

  it('passes arguments through and does not log when the handler succeeds', () => {
    const trigger = makeFakeTrigger();
    const event = new HappyEvent(makePlugin(trigger));

    event.register();

    const callback = trigger.captured.callback as (...args: unknown[]) => void;
    callback('a', 'b');
    callback(42);

    expect(event.calls).toEqual([['a', 'b'], [42]]);
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
