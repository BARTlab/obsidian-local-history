/**
 * Performance Jest project. Runs only the microbenchmarks under tests/perf/**.
 * Kept separate from jest.config.js so the default `npm test` dev loop stays
 * fast and never pays the bench cost. DOM-free by design (node environment,
 * no jsdom): the harness uses node:perf_hooks only.
 *
 * The `test:perf` npm script runs this project with `NODE_OPTIONS=--expose-gc`
 * so the harness can force a GC before each timed sample (GC is the dominant
 * run-to-run noise source on the allocation-heavy diff/render paths). The flag
 * must be in the environment before Node starts - setting it from inside this
 * config is too late, as Jest's forked workers do not pick up a --expose-gc
 * added at config-evaluation time. Absent the flag the harness GC call is a
 * graceful no-op and the gate falls back to its hybrid ceiling.
 *
 * @type {import('ts-jest').JestConfigWithTsJest}
 */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests/perf'],
  testMatch: ['**/*.perf.ts'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    // lodash-es is ESM only; route it to a CommonJS-friendly stub so engine
    // model files can be imported directly under the CommonJS Jest runtime.
    '^lodash-es$': '<rootDir>/tests/stubs/lodash-es.ts',
    // The obsidian package ships type declarations only (no runtime value), so
    // any source file importing a runtime value from it cannot be resolved
    // under Jest. Route it to an inert stub.
    '^obsidian$': '<rootDir>/tests/stubs/obsidian.ts',
  },
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        // The project tsconfig emits ESNext modules for esbuild; the Jest
        // runtime is CommonJS, so compile bench sources to CommonJS here.
        // The project's `bundler` moduleResolution does not auto-include
        // @types/node under CommonJS, so `node:` builtin imports and
        // __dirname fail to resolve. Pin `node` resolution (the benches read
        // the baseline via node:fs/node:path) and silence the TS6 deprecation
        // of that resolution mode (it is still valid until TS7).
        tsconfig: {
          module: 'commonjs',
          moduleResolution: 'node',
          types: ['node'],
          ignoreDeprecations: '6.0',
        },
      },
    ],
  },
};
