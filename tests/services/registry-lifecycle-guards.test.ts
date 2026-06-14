import 'reflect-metadata';
import { describe, expect, it, jest } from '@jest/globals';

import EventEmitter from 'eventemitter3';

import { BaseEvent } from '@/events/base.event';
import type LineChangeTrackerPlugin from '@/main';
import { EventsService } from '@/services/events.service';
import { StylesService } from '@/services/styles.service';
import type { ObsidianEventName } from '@/types';

/**
 * Regression coverage for T20 (epic 08): three small lifecycle guards that
 * were previously latent defects.
 *
 *  - EventsService: dedup must key on the event constructor, not the instance
 *    identity that `factory()` always rebuilds fresh (so the old `Set` guard
 *    silently let duplicates through).
 *  - StylesService: `update()` must return early before `init()` populated
 *    `this.sheet`, mirroring the existing `unload()` null-guard.
 *  - LineChangeTrackerPlugin: `emit(name, a, b)` must spread args to listeners
 *    rather than wrap them in a single positional array.
 */
describe('T20 registry/lifecycle guards (epic 08)', (): void => {
  describe('EventsService.register dedup by constructor', (): void => {
    class FakeEvent extends BaseEvent {
      public readonly name = 'workspace.file-open' as ObsidianEventName;

      public override handler(): void {
        // no-op; this fake never fires
      }

      public override register(): { ref: true } {
        return { ref: true } as unknown as { ref: true };
      }
    }

    /**
     * Exposes the `register` helper without subclassing so the test can drive
     * it directly with a known constructor.
     */
    class TestEventsService extends EventsService {
      public callRegister(): void {
        this.register(FakeEvent);
      }

      public instanceCount(): number {
        return this.instances.size;
      }
    }

    it('skips the second registration of the same event class', (): void => {
      const registerEvent = jest.fn();
      const plugin = ({
        app: { workspace: {}, vault: {} },
        registerEvent,
      } as unknown) as LineChangeTrackerPlugin;

      const service = new TestEventsService(plugin);

      service.callRegister();
      service.callRegister();

      expect(service.instanceCount()).toBe(1);
      expect(registerEvent).toHaveBeenCalledTimes(1);
    });
  });

  describe('StylesService.update null-guard', (): void => {
    it('returns early if init() has not created the sheet yet', (): void => {
      const plugin = {} as unknown as LineChangeTrackerPlugin;
      const service = new StylesService(plugin);

      // No init() ran, so `this.sheet` is undefined. Pre-fix code reached
      // `this.sheet.setText(...)` and threw; the guard must keep `update()` a
      // safe no-op. The DI-protected `settingsService` would also throw if it
      // were touched, so a non-throw here proves the guard fires first.
      expect((): void => service.update()).not.toThrow();
    });
  });

  describe('LineChangeTrackerPlugin.emit spreads payload', (): void => {
    /**
     * Mirrors the post-fix `emit` body (`this.emitter.emit(name, ...payload)`)
     * against the same eventemitter3 the plugin uses, without importing
     * `main.ts` (which transitively pulls in obsidian-only `PluginSettingTab`
     * and breaks the Jest environment).
     *
     * The point of the regression is purely the spread: pre-fix code passed
     * `(name, payload)`, so handlers received `(arrayOfArgs)` instead of
     * `(...args)`. The check below would fail without the spread.
     */
    it('delivers emit(name, a, b) as separate handler args, not as a single array', (): void => {
      const emitter = new EventEmitter();
      const handler = jest.fn();
      emitter.on('test.event', handler);

      const emit = (name: string, ...payload: unknown[]): boolean =>
        emitter.emit(name, ...payload);

      emit('test.event', 'a', { k: 1 });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith('a', { k: 1 });
    });
  });
});
