/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  // Benchmarks live under tests/perf/ and run only via the dedicated perf
  // project (jest.config.perf.js). Keep the default `npm test` from picking
  // them up even if a future bench is named *.test.ts by mistake.
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/tests/perf/'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    // lodash-es is ESM only; route it to a CommonJS-friendly stub so the engine
    // model files can be imported directly under the CommonJS Jest runtime.
    '^lodash-es$': '<rootDir>/tests/stubs/lodash-es.ts',
    // The obsidian package ships type declarations only (no runtime value), so
    // any source file importing a runtime value from it (e.g. Notice) cannot be
    // resolved under Jest. Route it to an inert stub.
    '^obsidian$': '<rootDir>/tests/stubs/obsidian.ts',
  },
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        // The project tsconfig emits ESNext modules for esbuild; the Jest
        // runtime is CommonJS, so compile test sources to CommonJS here.
        tsconfig: {
          module: 'commonjs',
        },
      },
    ],
  },
};
