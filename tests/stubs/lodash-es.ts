/**
 * Stand-in for the handful of lodash-es functions the engine imports. The
 * bare `lodash-es` specifier is routed here via the vitest resolve alias so the
 * real SettingsService (`get`/`merge`/`set`) and DomHelper
 * (`castArray`/`isPlainObject`) load under test against a small, deterministic
 * implementation rather than the full lodash-es dependency chain.
 * The implementations match lodash semantics for the values used in this code.
 */
export const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const castArray = <T>(value: T | T[]): T[] => (Array.isArray(value) ? value : [value]);

export const get = (object: unknown, path: string): unknown => {
  let current: unknown = object;

  for (const key of path.split('.')) {
    if (!isPlainObject(current)) {
      return undefined;
    }

    current = current[key];
  }

  return current;
};

export const set = <T>(object: T, path: string, value: unknown): T => {
  const keys = path.split('.');
  let current = object as Record<string, unknown>;

  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];

    if (!isPlainObject(current[key])) {
      current[key] = {};
    }

    current = current[key] as Record<string, unknown>;
  }

  current[keys[keys.length - 1]] = value;

  return object;
};

export const merge = <T extends Record<string, unknown>>(target: T, ...sources: unknown[]): T => {
  for (const source of sources) {
    if (!isPlainObject(source)) {
      continue;
    }

    for (const key of Object.keys(source)) {
      const srcValue = source[key];

      if (isPlainObject(srcValue)) {
        if (!isPlainObject(target[key])) {
          (target as Record<string, unknown>)[key] = {};
        }

        merge(target[key] as Record<string, unknown>, srcValue);
      } else if (srcValue !== undefined) {
        (target as Record<string, unknown>)[key] = srcValue;
      }
    }
  }

  return target;
};
