import type { ServiceToken } from '@/services/tokens';

/**
 * Narrow resolution surface an injected consumer depends on: resolve a
 * registered service by its stable token. Consumers type against this instead
 * of the full plugin, so the container's read side is their only DI coupling.
 */
export interface Container {
  get<T extends {}>(token: ServiceToken<T>): T;
}
