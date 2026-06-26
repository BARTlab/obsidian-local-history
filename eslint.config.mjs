import globals from 'globals';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import stylistic from '@stylistic/eslint-plugin';

export default [
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.es2021,
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      '@stylistic': stylistic,
    },
    rules: {
      'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
      'new-cap': ['error', { capIsNew: false }],
      'max-params': ['warn', 4],
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_|Inject|ServiceToken',
      }],
      '@typescript-eslint/no-inferrable-types': 'off',
      '@typescript-eslint/explicit-member-accessibility': ['warn', { accessibility: 'explicit' }],
      '@typescript-eslint/consistent-type-imports': ['warn', { prefer: 'type-imports' }],
      '@typescript-eslint/array-type': ['warn', { default: 'array' }],

      '@stylistic/linebreak-style': ['error', 'unix'],
      '@stylistic/padding-line-between-statements': [
        'error',
        { blankLine: 'always', prev: 'block-like', next: '*' },
        { blankLine: 'always', prev: '*', next: 'block-like' },
        { blankLine: 'always', prev: '*', next: 'return' },
        { blankLine: 'always', prev: 'multiline-const', next: '*' },
        { blankLine: 'always', prev: 'multiline-let', next: '*' },
        { blankLine: 'always', prev: 'multiline-var', next: '*' },
      ],
      '@stylistic/array-bracket-newline': ['warn', 'consistent'],
      '@stylistic/array-bracket-spacing': ['warn', 'never'],
      '@stylistic/array-element-newline': ['warn', 'consistent'],
      '@stylistic/object-curly-spacing': ['warn', 'always'],
      '@stylistic/max-len': ['warn', {
        ignorePattern: '^import |^export | implements | className',
        code: 120,
        tabWidth: 2,
      }],
      '@stylistic/arrow-spacing': 'warn',
      '@stylistic/block-spacing': 'warn',
      '@stylistic/function-call-argument-newline': ['warn', 'consistent'],
      '@stylistic/space-before-function-paren': ['warn', {
        anonymous: 'never',
        named: 'never',
        asyncArrow: 'always',
      }],
      '@stylistic/quote-props': ['warn', 'consistent'],
      '@stylistic/no-multiple-empty-lines': ['warn', { max: 1, maxEOF: 1 }],
      '@stylistic/arrow-parens': ['warn', 'always'],
      '@stylistic/quotes': ['warn', 'single'],
    },
  },
  {
    // Test tree: same stylistic baseline as src, with jest+node environment
    // globals and a few minimal, justified relaxations for test-only code.
    files: ['tests/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.jest,
        ...globals.node,
        ...globals.browser,
        ...globals.es2021,
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      '@stylistic': stylistic,
    },
    rules: {
      'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
      'new-cap': ['error', { capIsNew: false }],
      // Test arrange-blocks legitimately wire many collaborators into one stub.
      'max-params': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_|Inject|ServiceToken',
      }],
      '@typescript-eslint/no-inferrable-types': 'off',
      // Inline ad-hoc stub objects/classes do not need explicit accessibility.
      '@typescript-eslint/explicit-member-accessibility': 'off',
      '@typescript-eslint/consistent-type-imports': ['warn', { prefer: 'type-imports' }],
      '@typescript-eslint/array-type': ['warn', { default: 'array' }],

      '@stylistic/linebreak-style': ['error', 'unix'],
      '@stylistic/padding-line-between-statements': [
        'error',
        { blankLine: 'always', prev: 'block-like', next: '*' },
        { blankLine: 'always', prev: '*', next: 'block-like' },
        { blankLine: 'always', prev: '*', next: 'return' },
        { blankLine: 'always', prev: 'multiline-const', next: '*' },
        { blankLine: 'always', prev: 'multiline-let', next: '*' },
        { blankLine: 'always', prev: 'multiline-var', next: '*' },
      ],
      '@stylistic/array-bracket-newline': ['warn', 'consistent'],
      '@stylistic/array-bracket-spacing': ['warn', 'never'],
      '@stylistic/array-element-newline': ['warn', 'consistent'],
      '@stylistic/object-curly-spacing': ['warn', 'always'],
      // Off in tests: fixture literals, inline stub type annotations, and long
      // expect chains routinely exceed 120 cols, where wrapping hurts readability.
      '@stylistic/max-len': 'off',
      '@stylistic/arrow-spacing': 'warn',
      '@stylistic/block-spacing': 'warn',
      '@stylistic/function-call-argument-newline': ['warn', 'consistent'],
      '@stylistic/space-before-function-paren': ['warn', {
        anonymous: 'never',
        named: 'never',
        asyncArrow: 'always',
      }],
      '@stylistic/quote-props': ['warn', 'consistent'],
      '@stylistic/no-multiple-empty-lines': ['warn', { max: 1, maxEOF: 1 }],
      '@stylistic/arrow-parens': ['warn', 'always'],
      '@stylistic/quotes': ['warn', 'single'],
    },
  },
];
