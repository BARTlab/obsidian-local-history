/**
 * Minimal local replacements for the handful of lodash-es functions the
 * plugin used (`castArray`, `isPlainObject`, `get`, `set`, `merge`), so the
 * bundle carries no lodash dependency chain. The implementations match lodash
 * semantics for the values used in this codebase: dot-separated string paths
 * and plain-object deep merging.
 */

/**
 * Reports whether a value is a plain object (not null, not an array).
 *
 * @param {unknown} value - The value to test
 * @return {boolean} True when the value is a non-array object
 */
export const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Wraps a non-array value in an array; returns an array unchanged.
 *
 * @param {T | T[]} value - The value to normalize
 * @return {T[]} The value as an array
 */
export const castArray = <T>(value: T | T[]): T[] => (Array.isArray(value) ? value : [value]);

/**
 * Resolves a dot-separated path against an object, undefined when any hop is
 * not a plain object.
 *
 * @param {unknown} object - The root object to read from
 * @param {string} path - The dot-separated key path
 * @return {unknown} The value at the path, or undefined
 */
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

/**
 * Writes a value at a dot-separated path, creating intermediate plain objects
 * as needed. Mutates and returns the target.
 *
 * @param {T} object - The target object to write into
 * @param {string} path - The dot-separated key path
 * @param {unknown} value - The value to write
 * @return {T} The mutated target
 */
export const set = <T>(object: T, path: string, value: unknown): T => {
  const keys: string[] = path.split('.');
  let current: Record<string, unknown> = object as Record<string, unknown>;

  for (let i = 0; i < keys.length - 1; i++) {
    const key: string = keys[i];

    if (!isPlainObject(current[key])) {
      current[key] = {};
    }

    current = current[key] as Record<string, unknown>;
  }

  current[keys[keys.length - 1]] = value;

  return object;
};

export function merge<T extends object, S1>(target: T, source1: S1): T & S1;

export function merge<T extends object, S1, S2>(target: T, source1: S1, source2: S2): T & S1 & S2;

/**
 * Deep-merges plain-object sources into the target, later sources winning.
 * Non-object values (including arrays) overwrite; undefined source values are
 * skipped so defaults survive sparse saves. Mutates and returns the target;
 * the overloads type it as the intersection of all inputs.
 *
 * @param {Record<string, unknown>} target - The object merged into
 * @param {unknown[]} sources - The objects merged over it, in order
 * @return {Record<string, unknown>} The mutated target
 */
export function merge(target: Record<string, unknown>, ...sources: unknown[]): Record<string, unknown> {
  for (const source of sources) {
    if (!isPlainObject(source)) {
      continue;
    }

    for (const key of Object.keys(source)) {
      const srcValue: unknown = source[key];

      if (isPlainObject(srcValue)) {
        if (!isPlainObject(target[key])) {
          target[key] = {};
        }

        merge(target[key] as Record<string, unknown>, srcValue);
      } else if (srcValue !== undefined) {
        target[key] = srcValue;
      }
    }
  }

  return target;
}
