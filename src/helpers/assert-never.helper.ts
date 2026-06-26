/**
 * Compile-time exhaustiveness guard for enum and union switches. Placed in a
 * switch `default` branch, it forces the checked value to have been narrowed to
 * `never`, so adding a new union member without a matching case becomes a type
 * error at that call site. Reaching it at runtime means an out-of-band value
 * slipped past the type system, so it throws with an optional context label
 * instead of failing silently.
 *
 * @param {never} value - The value that must have been narrowed to never
 * @param {string} label - Optional context describing what was switched on
 * @return {never} Never returns; always throws
 */
export function assertNever(value: never, label?: string): never {
  const suffix: string = label ? ` for ${label}` : '';

  throw new Error(`Unexpected value "${String(value)}"${suffix}`);
}
