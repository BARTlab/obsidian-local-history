import type { CommandsService } from '@/services/commands.service';
import type { EventsService } from '@/services/events.service';
import type { ExtensionsService } from '@/services/extensions.service';
import type { I18nService } from '@/services/i18n.service';
import type { ModalsService } from '@/services/modals.service';
import type { PersistenceService } from '@/services/persistence.service';
import type { SettingsService } from '@/services/settings.service';
import type { SnapshotsService } from '@/services/snapshots.service';
import type { StatusbarService } from '@/services/statusbar.service';
import type { StylesService } from '@/services/styles.service';
import type { PropertyDecoratorService } from '@/services/property-decorator.service';
import type { TreeTabDecoratorService } from '@/services/tree-tab-decorator.service';
import type { VersionActionsService } from '@/services/version-actions.service';

/**
 * A stable, typed key for a service registered in the DI container.
 *
 * The token is a `symbol` so it survives esbuild minification untouched (unlike
 * `constructor.name`, which only stays stable because the bundle pins
 * `keepNames: true`). The phantom `T` carries the resolved service type so
 * `plugin.get(TOKENS.settings)` and `@Inject(TOKENS.settings)` return the right
 * type without a cast.
 *
 * The `description` of the underlying symbol is the legacy class name. This is
 * what lets the container keep a back-compat string fallback during the
 * incremental migration (C2-C4): an unmigrated `@Inject('SettingsService')`
 * still resolves by matching the string against `token.description`. The
 * fallback (and this coupling to the class name) is removed in C5, after every
 * call site has moved to a token.
 *
 * @template T - The service instance type this token resolves to
 */
export type ServiceToken<T> = symbol & { readonly __service?: T };

/**
 * Reverse lookup from a token back to its legacy class name.
 *
 * The back-compat string fallback and the "not registered" error label both
 * need the legacy name, but `Symbol.prototype.description` is ES2019 and the
 * build targets ES2018. Keying the name here (instead of off `.description`)
 * keeps the fallback target-safe and removable in one place at C5.
 */
const TOKEN_NAMES: Map<symbol, string> = new Map();

/**
 * Mints a typed service token tagged with the legacy class name.
 *
 * @template T - The service instance type the token resolves to
 * @param {string} name - The legacy class name, recorded in {@link TOKEN_NAMES}
 *   so the container's back-compat string fallback can match it
 * @return {ServiceToken<T>} A typed, unique token
 */
const token = <T>(name: string): ServiceToken<T> => {
  const sym: ServiceToken<T> = Symbol(name) as ServiceToken<T>;

  TOKEN_NAMES.set(sym, name);

  return sym;
};

/**
 * Catalog of DI tokens, one per service registered in `main.ts`.
 *
 * This is the single source of truth the per-layer batches (C2-C4) migrate
 * their `@Inject` call sites toward. Each token is keyed independently of
 * `constructor.name`, so once every consumer uses a token the container no
 * longer depends on minified class names and `keepNames` can be dropped (C5).
 */
export const TOKENS = {
  settings: token<SettingsService>('SettingsService'),
  i18n: token<I18nService>('I18nService'),
  styles: token<StylesService>('StylesService'),
  modals: token<ModalsService>('ModalsService'),
  extensions: token<ExtensionsService>('ExtensionsService'),
  statusbar: token<StatusbarService>('StatusbarService'),
  commands: token<CommandsService>('CommandsService'),
  events: token<EventsService>('EventsService'),
  snapshots: token<SnapshotsService>('SnapshotsService'),
  versionActions: token<VersionActionsService>('VersionActionsService'),
  persistence: token<PersistenceService>('PersistenceService'),
  treeTabDecorator: token<TreeTabDecoratorService>('TreeTabDecoratorService'),
  propertyDecorator: token<PropertyDecoratorService>('PropertyDecoratorService'),
} as const;

/**
 * Resolves the legacy class name a token was minted with.
 *
 * Used by the container's back-compat string fallback to match an unmigrated
 * `@Inject('Name')` against a token, and to label "not registered" errors.
 * Removed alongside the fallback at C5.
 *
 * @param {symbol} sym - The token to look up
 * @return {string | undefined} The legacy class name, or undefined if unknown
 */
export const tokenName = (sym: symbol): string | undefined => TOKEN_NAMES.get(sym);
