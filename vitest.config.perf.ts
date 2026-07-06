import { defineConfig } from 'vitest/config';

import { aliases } from './vitest.aliases';

/**
 * Performance project. Runs only the microbenchmarks under tests/perf/**.
 * Kept separate from vitest.config.ts so the default `npm test` dev loop stays
 * fast and never pays the bench cost. DOM-free by design (node environment):
 * the harness uses node:perf_hooks only; the diff bench opts into jsdom via its
 * own `// @vitest-environment jsdom` docblock.
 *
 * The `test:perf` npm script runs this project with `NODE_OPTIONS=--expose-gc`
 * so the harness can force a GC before each timed sample (GC is the dominant
 * run-to-run noise source on the allocation-heavy diff/render paths). The flag
 * must be in the environment before Node starts; the forked test workers
 * inherit it via NODE_OPTIONS. Absent the flag the harness GC call is a
 * graceful no-op and the gate falls back to its hybrid ceiling.
 */
export default defineConfig({
  resolve: { alias: aliases },
  test: {
    include: ['tests/perf/**/*.perf.ts'],
    environment: 'node',
  },
});
