/**
 * CommonJS-friendly stand-in for the handful of lodash-es predicates the engine
 * imports. lodash-es ships ESM only, which the CommonJS Jest runtime cannot
 * require directly; mapping the bare specifier here lets the real FileSnapshot,
 * TrackerLine and ArrayMap load under test without pulling the ESM chain.
 * The implementations match lodash semantics for the values used in this code.
 */
export const isArray = (value: unknown): value is unknown[] => Array.isArray(value);

export const isNumber = (value: unknown): value is number => typeof value === 'number';

export const isString = (value: unknown): value is string => typeof value === 'string';

export const isFunction = (value: unknown): boolean => typeof value === 'function';
