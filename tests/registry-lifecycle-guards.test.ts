/** @vitest-environment jsdom */
import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';

import { BaseEvent } from '@/events/base.event';
import type LineChangeTrackerPlugin from '@/main';
import { EventsService } from '@/services/events.service';
import { StylesService } from '@/services/styles.service';
import type { ObsidianEventName } from '@/types';

/**
 * Regression coverage: two small lifecycle guards that
 * were previously latent defects.
 *
 *  - EventsService: dedup must key on the event constructor, not the instance
 *    identity that `factory()` always rebuilds fresh (so the old `Set` guard
 *    silently let duplicates through).
 *  - StylesService: `update()` writes the settings-driven marker geometry as
 *    CSS custom properties on `document.body` and injects no `<style>` element,
 *    and `unload()` clears those properties.
 */
describe('Registry/lifecycle guards', (): void => {
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
      const registerEvent = vi.fn();
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

  describe('StylesService.update writes marker geometry to document.body', (): void => {
    it('sets the width and radius custom properties and injects no <style> element', (): void => {
      // The @Inject getter resolves settingsService via plugin.get(); the stub
      // returns a settings object whose value() reports the line width.
      const plugin = {
        get: (): { value: () => number } => ({ value: (): number => 6 }),
      } as unknown as LineChangeTrackerPlugin;

      const service = new StylesService(plugin);

      service.update();

      expect(document.body.style.getPropertyValue('--lct-line-width')).toBe('6px');
      expect(document.body.style.getPropertyValue('--lct-line-border-radius')).toBe('3px');
      expect(document.getElementById('line-change-tracker-styles')).toBeNull();

      service.unload();

      expect(document.body.style.getPropertyValue('--lct-line-width')).toBe('');
      expect(document.body.style.getPropertyValue('--lct-line-border-radius')).toBe('');
    });
  });

});
