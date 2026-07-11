import { META_INJECT, META_ON_EVENT } from '@/decorators/meta-keys';
import type { Container } from '@/services/container.types';
import { type ServiceToken, tokenName } from '@/services/tokens';
import type { ClassConstructor, Service } from '@/types';
import type EventEmitter from 'eventemitter3';

/**
 * Owns the plugin's service instances under one insertion-ordered, symbol-keyed
 * map and runs their lifecycle with per-service error isolation. The plugin
 * composes it, passing the emitter used to wire @On listeners and itself as the
 * host every service constructor receives, then delegates resolution and
 * lifecycle here so it holds no DI map of its own.
 *
 * @template H - The host type every registered service constructor receives
 */
export class ServiceContainer<H extends object = object> implements Container {
  /** Registered services keyed by their stable token, in registration order. */
  private readonly services: Map<symbol, Service> = new Map();

  /**
   * Services whose `init` resolved successfully in the current lifecycle, so a
   * fatal init tears down only what is actually up, in reverse registration
   * order.
   */
  private readonly initialized: Service[] = [];

  public constructor(
    private readonly emitter: EventEmitter,
    private readonly host: H,
  ) {}

  /**
   * Registers a service under its token: instantiates it with the host, stores
   * it in the token map, and wires every @On-decorated method to the emitter.
   *
   * @template T - The service type
   * @param {ClassConstructor<T, [H]>} provider - The service class constructor
   * @param {ServiceToken<T>} token - The stable token to key the instance by
   */
  public register<T extends object>(provider: ClassConstructor<T, [H]>, token: ServiceToken<T>): void {
    // eslint-disable-next-line new-cap -- the DI container instantiates the injected class constructor
    const inst: T = new provider(this.host);

    this.services.set(token, inst);

    for (const prop of Object.getOwnPropertyNames(Object.getPrototypeOf(inst))) {
      const event: { name: string } | undefined =
        Reflect.getMetadata(META_ON_EVENT, inst, prop) as { name: string } | undefined;

      const inject: boolean | undefined = Reflect.getMetadata(META_INJECT, inst, prop) as boolean | undefined;

      if (!inject && event && prop in inst) {
        const method: unknown = (inst as Record<string, unknown>)[prop];

        if (typeof method === 'function') {
          this.emitter.on(event.name, method as (...args: unknown[]) => void, inst);
        }
      }
    }
  }

  /**
   * Resolves a registered service by its token.
   *
   * @template T - The service type
   * @param {ServiceToken<T>} token - The token to resolve
   * @return {T} The service instance
   * @throws Error if no service is registered under the token
   */
  public get<T extends object>(token: ServiceToken<T>): T {
    const service: T | undefined = this.services.get(token) as T | undefined;

    if (!service) {
      throw new Error(`Service '${tokenName(token) ?? token.toString()}' not registered`);
    }

    return service;
  }

  /**
   * Executes a lifecycle method on every service in registration order. Each
   * call is isolated in try/catch so one failure does not abort the loop. A
   * successful `init` records the service so teardown reverses only what came
   * up; `unload` clears the corresponding entry.
   *
   * @param {keyof Service} method - The lifecycle method to run on each service
   * @return {Promise<boolean>} True when at least one service threw, so the
   *   caller can tear down the partial container.
   */
  public async exec(method: keyof Service): Promise<boolean> {
    let failed: boolean = false;

    for (const provider of [...this.services.values()]) {
      if (method in provider && typeof provider[method] === 'function') {
        try {
          await provider[method]();

          if (method === 'init') {
            this.initialized.push(provider);
          } else if (method === 'unload') {
            const idx: number = this.initialized.indexOf(provider);

            if (idx >= 0) {
              this.initialized.splice(idx, 1);
            }
          }
        } catch (error) {
          failed = true;
          console.error(
            `[obsidian-local-history] ${provider.constructor.name}.${method} failed:`,
            error,
          );
        }
      }
    }

    return failed;
  }

  /**
   * Tears down the services brought up by a partial `init`/`load`, in reverse
   * registration order, each isolated so one teardown failure does not block
   * the rest.
   *
   * @return {Promise<void>} Resolves once teardown is complete.
   */
  public async teardown(): Promise<void> {
    for (const provider of [...this.initialized].reverse()) {
      if ('unload' in provider && typeof provider.unload === 'function') {
        try {
          await provider.unload();
        } catch (error) {
          console.error(
            `[obsidian-local-history] ${provider.constructor.name}.unload failed during teardown:`,
            error,
          );
        }
      }
    }

    this.initialized.length = 0;
  }
}
