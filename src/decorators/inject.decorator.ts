import { META_INJECT } from '@/decorators/meta-keys';
import type { Container } from '@/services/container';
import type { ServiceToken } from '@/services/tokens';
import type { Service } from '@/types';

/**
 * Decorator that injects a service dependency into a class property.
 * Creates a getter that resolves the service from the plugin's container when
 * the property is accessed and blocks direct assignment.
 *
 * Accepts a {@link ServiceToken} - the stable, minification-safe key every
 * consumer uses - so injection never depends on class names surviving the
 * bundle.
 *
 * Strict-mode invariant: every `@Inject(...)` field is declared with the
 * definite-assignment modifier (`field!: Type`). The decorator replaces the
 * field with a getter that resolves the service from the container on access,
 * so the field is always defined before any read even though no constructor or
 * initializer assigns it. This invariant is stated here once and not repeated
 * per field.
 *
 * @template T - The type of service to inject
 * @param {ServiceToken<T>} token - The token to inject
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
export const Inject = <T extends {}>(
  token: ServiceToken<T>
): PropertyDecorator => {
  return (
    target: object,
    propertyKey: string | symbol,
  ): TypedPropertyDescriptor<T> | void => {
    Reflect.defineMetadata(META_INJECT, true, target, propertyKey);

    Object.defineProperty(target, propertyKey, {
      get(): Service {
        const container: Container | undefined = this['plugin'];

        if (container) {
          return container.get(token);
        }

        throw new Error(`"${target}" does not have a "plugin" property defined.`);
      },
      set(_value: unknown): never {
        throw new Error('You cannot change the value of a property with a service');
      },
    });
  };
};
