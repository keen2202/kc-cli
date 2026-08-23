// ESLint flat config for kc-cli
// Focus: architecture boundary enforcement + type-escape visibility.
// Complementary to test-level guards (dead-path-guard.test.ts owns UI contract rules).

import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', '.history/**', 'coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      // Legacy escapes exist (~110); surface as warnings, ratchet down over time.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      '@typescript-eslint/no-require-imports': 'warn',
      '@typescript-eslint/no-empty-object-type': 'warn',
      '@typescript-eslint/no-unsafe-function-type': 'warn',
      'no-empty': 'warn',
      'no-useless-escape': 'warn',
      'no-control-regex': 'off',
      'no-case-declarations': 'warn',
      'prefer-const': 'warn',
      'no-async-promise-executor': 'warn',
      // Legacy code-smell signals (ratchet to 'error' as files get touched).
      'preserve-caught-error': 'warn',
      'no-useless-assignment': 'warn',
      'require-yield': 'warn',
      'no-irregular-whitespace': 'warn',
      'no-misleading-character-class': 'warn',
    },
  },
  {
    // Architecture boundary: tools must never depend on UI or the query loop.
    files: ['src/tools/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/ui/**', '**/ui'],
              message: 'src/tools must not depend on src/ui (architecture boundary).',
            },
            {
              group: ['**/query/**', '**/query'],
              message: 'src/tools must not depend on src/query (architecture boundary).',
            },
          ],
        },
      ],
    },
  },
  {
    // T21 (audit round3 M5): console.log on hot paths corrupts the ink TUI —
    // post-turn hooks (src/memory) and query/executors code writing to stdout
    // tear the live render. Route diagnostics through the structured logger
    // (stderr JSON lines) instead: logger.query / logger.memory from
    // src/services/logger.ts. main.ts and src/commands are legitimate
    // REPL/CLI output and are intentionally outside this override.
    files: [
      'src/query/**/*.{ts,tsx}',
      'src/memory/**/*.{ts,tsx}',
      'src/executors/**/*.{ts,tsx}',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.object.name='console'][callee.property.name='log']",
          message:
            'console.log is banned under src/query|src/memory|src/executors (ink TUI corruption risk on stdout) — use logger.query/logger.memory from src/services/logger.',
        },
      ],
    },
  },
  {
    // Co-located tests may use looser typing.
    files: ['src/**/*.test.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  }
);
