import { META_INJECT } from '@/decorators/meta-keys';
import type { Container } from '@/services/container.types';
import type { ServiceToken } from '@/services/tokens';
import type { Service } from '@/types';

/**
 * Compile-time contract for an `@Inject` host: it must expose a public `plugin`
 * of the container shape so the decorator can resolve services through it. A
 * decorated class whose `plugin` is missing, protected, or a non-container type
 * fails to type-check against this target, which is the primary host guard (the
 * runtime throw below is defense in depth).
 */
interface HasPlugin {
  plugin: Container;
}

/**
 * Decorator that injects a service dependency into a class property.
 * Creates a getter that resolves the service from the plugin's container when
 * the property is accessed and blocks direct assignment.
 *
 * Accepts a {@link ServiceToken} - the stable, minification-safe key every
 * consumer uses - so injection never depends on class names surviving the
 * bundle. Its target is narrowed to {@link HasPlugin}, so tsc rejects any
 * decorated class that does not publicly hold a container-shaped `plugin`.
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
 * @return A property decorator (host-checked against {@link HasPlugin}) that installs the service getter
 *
 * @example
 * ```typescript
 * class MyService {
 *   @Inject(TOKENS.settings)
 *   public settingsService: SettingsService;
 * }
 * ```
 */
export const Inject = <T extends object>(
  token: ServiceToken<T>,
): ((target: HasPlugin, propertyKey: string | symbol) => void) => {
  return (
    target: HasPlugin,
    propertyKey: string | symbol,
  ): void => {
    Reflect.defineMetadata(META_INJECT, true, target, propertyKey);

    Object.defineProperty(target, propertyKey, {
      get(this: Partial<HasPlugin>): Service {
        const container: Container | undefined = this.plugin;

        if (container) {
          return container.get(token);
        }

        throw new Error(`"${target.constructor.name}" does not have a "plugin" property defined.`);
      },
      set(_value: unknown): never {
        throw new Error('You cannot change the value of a property with a service');
      },
    });
  };
};
