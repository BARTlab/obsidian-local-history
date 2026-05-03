/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
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
