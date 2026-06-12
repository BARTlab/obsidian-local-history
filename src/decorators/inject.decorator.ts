import type LineChangeTrackerPlugin from '@/main';
import type { ServiceToken } from '@/services/tokens';
import type { ClassConstructor, Service } from '@/types';

/**
 * Decorator that injects a service dependency into a class property.
 * Creates a getter that retrieves the service from the plugin's container when accessed.
 * Prevents direct assignment to the decorated property to maintain a dependency injection pattern.
 *
 * Accepts a {@link ServiceToken} (the stable, minification-safe key consumers
 * migrate toward), a class constructor, or a legacy class-name string. The
 * string form keeps working through the container's back-compat fallback until
 * C5 removes it; new and migrated call sites should use a token.
 *
 * @template T - The type of service to inject
 * @param {ServiceToken<T> | ClassConstructor<T> | string} cls - The token, class
 *   constructor, or service name to inject
 * @return {PropertyDecorator} A property decorator that replaces the property with a getter for the service
 *
 * @example
 * ```typescript
 * class MyService {
 *   @Inject(TOKENS.settings)
 *   protected settingsService: SettingsService;
 * }
 * ```
 */
export const Inject = <T>(
  cls: ServiceToken<T> | ClassConstructor<T> | string
): PropertyDecorator => {
  return (
    target: object,
    propertyKey: string | symbol,
  ): TypedPropertyDescriptor<T> | void => {
    Reflect.defineMetadata('INJECT', true, target, propertyKey);

    Object.defineProperty(target, propertyKey, {
      get(): Service {
        const plugin: LineChangeTrackerPlugin = this['plugin'];

        if (plugin) {
          return plugin.get(cls);
        }

        throw new Error(`"${target}" does not have a "plugin" property defined.`);
      },
      set(_value: unknown): never {
        throw new Error('You cannot change the value of a property with a service');
      },
    });
  };
};
