import 'reflect-metadata';
import { describe, expect, it, jest } from '@jest/globals';

import { MapChangeAction } from '@/consts';
import { ObservableMap } from '@/maps/observable.map';
import type { ChangeHandler } from '@/types';

/**
 * Dispatch must iterate a snapshot of the listener set so a listener
 * that subscribes or unsubscribes mid-dispatch cannot corrupt the in-progress
 * notification.
 */
describe('ObservableMap re-entrant dispatch', (): void => {
  it('lets a listener unsubscribe itself during dispatch without skipping later listeners', (): void => {
    const map: ObservableMap<string, number> = new ObservableMap<string, number>();
    const calls: string[] = [];

    const selfUnsub: ChangeHandler<string, number> = jest.fn(
      (action: MapChangeAction): void => {
        calls.push(`a:${action}`);
        map.unsubscribe(selfUnsub);
      }
    );

    const listenerB: ChangeHandler<string, number> = jest.fn(
      (action: MapChangeAction): void => {
        calls.push(`b:${action}`);
      }
    );

    const listenerC: ChangeHandler<string, number> = jest.fn(
      (action: MapChangeAction): void => {
        calls.push(`c:${action}`);
      }
    );

    map.subscribe(selfUnsub);
    map.subscribe(listenerB);
    map.subscribe(listenerC);

    expect((): void => {
      map.set('k', 1);
    }).not.toThrow();

    // First dispatch: all three fire because we iterate a snapshot.
    expect(calls).toEqual(['a:set', 'b:set', 'c:set']);

    // Second dispatch: self-unsubscriber is gone, b and c remain.
    map.set('k', 2);
    expect(calls).toEqual(['a:set', 'b:set', 'c:set', 'b:set', 'c:set']);
  });

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

  it('keeps normal set/delete/clear behaviour and force semantics unchanged', (): void => {
    const map: ObservableMap<string, number> = new ObservableMap<string, number>();
    const handler: ChangeHandler<string, number> = jest.fn();

    map.subscribe(handler);

    map.set('a', 1);
    expect(handler).toHaveBeenCalledWith(MapChangeAction.set, 'a', 1);

    // Same value, no force -> no notification.
    (handler as jest.Mock).mockClear();
    map.set('a', 1);
    expect(handler).not.toHaveBeenCalled();

    // Force still fires.
    map.set('a', 1, true);
    expect(handler).toHaveBeenCalledWith(MapChangeAction.set, 'a', 1);

    (handler as jest.Mock).mockClear();
    map.delete('a');
    expect(handler).toHaveBeenCalledWith(MapChangeAction.delete, 'a', undefined);

    // Delete missing without force -> no notification.
    (handler as jest.Mock).mockClear();
    map.delete('missing');
    expect(handler).not.toHaveBeenCalled();

    // Force on missing key fires.
    map.delete('missing', true);
    expect(handler).toHaveBeenCalledWith(MapChangeAction.delete, 'missing', undefined);

    (handler as jest.Mock).mockClear();
    map.set('b', 2);
    (handler as jest.Mock).mockClear();
    map.clear();
    expect(handler).toHaveBeenCalledWith(MapChangeAction.clear, undefined, undefined);
  });
});
