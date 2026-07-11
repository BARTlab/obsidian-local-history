import globals from 'globals';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import stylistic from '@stylistic/eslint-plugin';
import obsidianmd from 'eslint-plugin-obsidianmd';

// The same rule set the community-directory review bot runs (popout-window
// globals, manifest checks, bundled import/depend/eslint-comments rules), so
// `npm run lint` catches its findings before a submission does. Scoped to the
// bot's own scope (plugin sources + package.json): its type-aware rules need
// the project-backed parser, which only the src block configures.
const reviewBotConfig = obsidianmd.configs.recommended.map((block) =>
  JSON.stringify(block.files ?? '').includes('package.json') ? block : { ...block, files: ['src/**/*.ts'] });

export default [
  ...reviewBotConfig,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: {
        project: './tsconfig.json',
      },
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
      // One class per file; type/const neighbors are policed by scripts/check-class-purity.mjs.
      'max-classes-per-file': ['warn', 1],
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_|Inject|ServiceToken',
      }],
      '@typescript-eslint/no-inferrable-types': 'off',
      '@typescript-eslint/explicit-member-accessibility': ['warn', { accessibility: 'explicit' }],
      // Canonical member order. Getters/setters share the method ranks (the
      // nested arrays merge them into one rank), so no separate accessor
      // groups exist. Abstract members form *-abstract-* groups that are
      // intentionally absent from this list: they stay unranked.
      '@typescript-eslint/member-ordering': ['warn', {
        default: {
          memberTypes: [
            'signature',
            'public-static-field',
            'protected-static-field',
            'private-static-field',
            'public-instance-field',
            'protected-instance-field',
            'private-instance-field',
            'constructor',
            ['public-static-method', 'public-static-get', 'public-static-set'],
            ['protected-static-method', 'protected-static-get', 'protected-static-set'],
            ['private-static-method', 'private-static-get', 'private-static-set'],
            ['public-instance-method', 'public-instance-get', 'public-instance-set'],
            ['protected-instance-method', 'protected-instance-get', 'protected-instance-set'],
            ['private-instance-method', 'private-instance-get', 'private-instance-set'],
          ],
          order: 'as-written',
        },
      }],
      '@typescript-eslint/consistent-type-imports': ['warn', { prefer: 'type-imports' }],
      '@typescript-eslint/array-type': ['warn', { default: 'array' }],
      // DomHelper is the single element-creation seam and the jsdom suites
      // polyfill no createEl/createDiv; revisit if the bot starts flagging it.
      'obsidianmd/prefer-create-el': 'off',
      // Searchable setting definitions are an Obsidian 1.12+ feature tracked
      // as future work, not part of the review gate today.
      'obsidianmd/settings-tab/prefer-setting-definitions': 'off',
      // Type-aware rules the review bot flags beyond the obsidianmd preset.
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-misused-promises': 'warn',
      '@typescript-eslint/no-unnecessary-type-assertion': 'warn',
      '@typescript-eslint/no-empty-object-type': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',

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
    // Test tree: same stylistic baseline as src, with a node+browser
    // environment and a few minimal, justified relaxations for test-only code.
    // The vitest API (describe/it/expect/vi) is imported explicitly per file,
    // so no test-runner globals are declared here.
    files: ['tests/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
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
