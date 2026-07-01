import 'reflect-metadata';
import { describe, expect, it } from '@jest/globals';

/**
 * Module-load smoke test for the plugin entry point.
 *
 * `src/main.ts` wires the whole plugin graph (every service, view, modal and
 * extension) at import time. Nothing else imports it under Jest, so a broken
 * import - a bad decorator, a missing export, a top-level throw anywhere in the
 * transitive graph - would otherwise slip past the suite. Importing it here
 * through the obsidian stub turns any such regression into a failing test.
 */
describe('plugin entry point', () => {
  it('imports src/main.ts without throwing and exposes the plugin class', async () => {
    const module = await import('@/main');

    expect(typeof module.default).toBe('function');
  });
});
