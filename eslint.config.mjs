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
];
