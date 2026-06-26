/**
 * Reflect metadata keys, minted as unique symbols so they cannot collide with
 * other reflect-metadata users in the shared Obsidian runtime. Mirrors the
 * ServiceToken symbol convention in tokens.ts.
 */

/** Key under which `@On` records the event a method listens for. */
export const META_ON_EVENT: unique symbol = Symbol('lct:on-event');

/** Key under which `@Inject` marks a property as a container-resolved getter. */
export const META_INJECT: unique symbol = Symbol('lct:inject');
