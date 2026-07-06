import { defineConfig } from 'vitest/config';

import { aliases } from './vitest.aliases';

/**
 * Unit/integration config. Mirrors the retired jest.config.js:
 * - roots at tests/, matching **\/*.test.ts, excluding the perf project;
 * - path aliases replacing the old moduleNameMapper (see vitest.aliases.ts);
 * - a Node environment by default. Renderer suites opt into jsdom per file via
 *   a `// @vitest-environment jsdom` docblock, so the DOM-free unit tests never
 *   pay the jsdom cost.
 *
 * Unlike the CommonJS ts-jest runtime, vitest transpiles the sources with
 * esbuild reading tsconfig.json directly, so `experimentalDecorators` is picked
 * up for the @Inject/@On decorators. Those decorators key their own reflect
 * metadata symbols and resolve DI by explicit TOKENS, so the missing
 * `emitDecoratorMetadata` emit (esbuild does not synthesize design:* types) is
 * irrelevant here.
 */
export default defineConfig({
  resolve: { alias: aliases },
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules/**', 'tests/perf/**'],
    environment: 'node',
  },
});
