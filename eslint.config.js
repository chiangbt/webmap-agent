// Flat ESLint config for ESLint 9. The `lint` script predates flat config and
// previously failed outright ("couldn't find an eslint.config file"), so this
// config restores `pnpm lint`. Uses only packages already in devDependencies
// (no @eslint/js / globals meta-packages): core rules are referenced by name
// and the TypeScript plugin by its direct import.
import typescriptEslint from '@typescript-eslint/eslint-plugin';
import typescriptParser from '@typescript-eslint/parser';

// Browser + Node globals the sources and tests actually reference.
const browserGlobals = {
  window: 'readonly',
  document: 'readonly',
  navigator: 'readonly',
  location: 'readonly',
  sessionStorage: 'readonly',
  localStorage: 'readonly',
  console: 'readonly',
  fetch: 'readonly',
  Response: 'readonly',
  URL: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  requestAnimationFrame: 'readonly',
  cancelAnimationFrame: 'readonly',
  AbortController: 'readonly',
  ResizeObserver: 'readonly',
  MutationObserver: 'readonly',
  CustomEvent: 'readonly',
  Event: 'readonly',
  FocusEvent: 'readonly',
  KeyboardEvent: 'readonly',
  MouseEvent: 'readonly',
  Element: 'readonly',
  HTMLElement: 'readonly',
  HTMLDivElement: 'readonly',
  HTMLInputElement: 'readonly',
  HTMLTextAreaElement: 'readonly',
  HTMLSelectElement: 'readonly',
  HTMLDetailsElement: 'readonly',
  HTMLButtonElement: 'readonly',
  HTMLUListElement: 'readonly',
  HTMLLIElement: 'readonly',
  HTMLSpanElement: 'readonly',
  HTMLLabelElement: 'readonly',
  SVGElement: 'readonly',
  SVGSVGElement: 'readonly',
  CSSStyleDeclaration: 'readonly',
  DOMRect: 'readonly',
  getComputedStyle: 'readonly',
  FileReader: 'readonly',
  Blob: 'readonly',
  File: 'readonly',
};

const commonRules = {
  eqeqeq: ['error', 'smart'],
  'prefer-const': 'error',
  'no-var': 'error',
  'no-constant-condition': 'error',
  'no-dupe-keys': 'error',
  'no-duplicate-case': 'error',
  'no-fallthrough': 'error',
  'no-async-promise-executor': 'error',
  'no-loss-of-precision': 'error',
  'no-prototype-builtins': 'error',
  'no-sparse-arrays': 'error',
  'no-template-curly-in-string': 'warn',
  'no-unsafe-finally': 'error',
  'no-unreachable': 'error',
  'no-useless-escape': 'error',
  'no-empty-pattern': 'error',
  'no-shadow-restricted-names': 'error',
  'use-isnan': 'error',
  'valid-typeof': 'error',
  'object-shorthand': ['error', 'properties'],
  'no-case-declarations': 'error',
};

const tsRules = {
  ...commonRules,
  '@typescript-eslint/no-unused-vars': [
    'error',
    { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
  ],
  '@typescript-eslint/no-explicit-any': 'error',
  // The codebase deliberately narrows unknown shapes with assertions.
  '@typescript-eslint/no-non-null-assertion': 'off',
  '@typescript-eslint/ban-ts-comment': [
    'error',
    { 'ts-expect-error': 'allow-with-description', 'ts-ignore': true },
  ],
  // Core no-unused-vars would misread type-only usage; TS rules cover it.
  'no-unused-vars': 'off',
};

export default [
  {
    ignores: [
      'dist/**',
      'dist-examples/**',
      'coverage/**',
      'node_modules/**',
      '*.config.js',
      'components.json',
    ],
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: typescriptParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
      globals: browserGlobals,
    },
    plugins: {
      '@typescript-eslint': typescriptEslint,
    },
    rules: tsRules,
  },
];
