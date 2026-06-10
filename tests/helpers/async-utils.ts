/**
 * Drains the microtask queue so a scheduled debounce callback that already
 * resolved its inner promise has a chance to write its side effects before
 * the test asserts on them.
 */
export const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};
