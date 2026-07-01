import 'reflect-metadata';
import { describe, expect, it, jest } from '@jest/globals';

import { MapChangeAction } from '@/consts';
import { ObservableMap } from '@/maps/observable.map';
import type { ChangeHandler } from '@/types';

/**
 * Dispatch must iterate a snapshot of the listener set so a listener that
 * subscribes a new one mid-dispatch cannot corrupt the in-progress notification.
 */
describe('ObservableMap re-entrant dispatch', (): void => {
  it('completes a dispatch over the original set when a listener subscribes a new one mid-flight', (): void => {
    const map: ObservableMap<string, number> = new ObservableMap<string, number>();
    const calls: string[] = [];

    const lateListener: ChangeHandler<string, number> = jest.fn(
      (action: MapChangeAction): void => {
        calls.push(`late:${action}`);
      }
    );

    const subscriber: ChangeHandler<string, number> = jest.fn(
      (action: MapChangeAction): void => {
        calls.push(`sub:${action}`);
        map.subscribe(lateListener);
      }
    );

    const listenerTail: ChangeHandler<string, number> = jest.fn(
      (action: MapChangeAction): void => {
        calls.push(`tail:${action}`);
      }
    );

    map.subscribe(subscriber);
    map.subscribe(listenerTail);

    map.set('k', 1);

    // Original snapshot only: subscriber and tail. lateListener does NOT fire here.
    expect(calls).toEqual(['sub:set', 'tail:set']);

    // On the next dispatch lateListener is in the snapshot and fires.
    map.set('k', 2);
    expect(calls).toEqual(['sub:set', 'tail:set', 'sub:set', 'tail:set', 'late:set']);
  });

  it('keeps normal set/delete/clear notification behaviour', (): void => {
    const map: ObservableMap<string, number> = new ObservableMap<string, number>();
    const handler: ChangeHandler<string, number> = jest.fn();

    map.subscribe(handler);

    map.set('a', 1);
    expect(handler).toHaveBeenCalledWith(MapChangeAction.set, 'a', 1);

    // Same value -> no notification.
    (handler as jest.Mock).mockClear();
    map.set('a', 1);
    expect(handler).not.toHaveBeenCalled();

    (handler as jest.Mock).mockClear();
    map.delete('a');
    expect(handler).toHaveBeenCalledWith(MapChangeAction.delete, 'a', undefined);

    // Delete missing -> no notification.
    (handler as jest.Mock).mockClear();
    map.delete('missing');
    expect(handler).not.toHaveBeenCalled();

    (handler as jest.Mock).mockClear();
    map.set('b', 2);
    (handler as jest.Mock).mockClear();
    map.clear();
    expect(handler).toHaveBeenCalledWith(MapChangeAction.clear, undefined, undefined);
  });
});
