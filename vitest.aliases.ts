import { resolve } from 'node:path';

/**
 * Path aliases shared by the unit and perf vitest configs. These replace the
 * old ts-jest `moduleNameMapper`:
 * - `@/x` -> `<root>/src/x`, the source path alias used throughout;
 * - obsidian is routed to a test stub: the package ships types only (no
 *   runtime value), so runtime-value imports like Notice need an inert
 *   stand-in.
 */
export const aliases = [
  { find: '@', replacement: resolve(__dirname, 'src') },
  { find: /^obsidian$/, replacement: resolve(__dirname, 'tests/stubs/obsidian.ts') },
];
