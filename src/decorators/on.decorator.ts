import { META_ON_EVENT } from '@/decorators/meta-keys';

/**
 * Decorator that marks a method to be called when a specific event is emitted.
 * Associates the method with an event name using metadata.
 * When the event is emitted, the plugin's event system will invoke the decorated method.
 *
 * @param {string} name - The name of the event to listen for
 * @return {MethodDecorator} A method decorator that registers the method as an event handler
 *
 * @example
 * ```typescript
 * @On(PluginEvent.snapshotsUpdate)
 * public updateFileStatus(): void {
 *   this.refresh();
 * }
 * ```
 */
export const On = (
  name: string,
): MethodDecorator => {
  return (target: object, propertyKey: string | symbol): void => {
    return Reflect.defineMetadata(META_ON_EVENT, { name }, target, propertyKey);
  };
};
