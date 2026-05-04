/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    // lodash-es is ESM only; route it to a CommonJS-friendly stub so the engine
    // model files can be imported directly under the CommonJS Jest runtime.
    '^lodash-es$': '<rootDir>/tests/stubs/lodash-es.ts',
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
