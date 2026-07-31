import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.{ts,tsx}'],
    exclude: ['node_modules', 'dist'],
    coverage: {
      provider: 'v8',
      include: [
        'src/services/**/*.ts',
        'src/permissions/**/*.ts',
        'src/orchestrator/**/*.ts',
        'src/tools/**/*.ts',
        'src/api/**/*.ts',
        'src/bootstrap/**/*.ts',
        'src/query/**/*.ts',
        'src/utils/**/*.ts',
        'src/state/**/*.ts',
        'src/executors/**/*.ts',
        'src/memory/**/*.ts',
        'src/lsp/**/*.ts',
        'src/mcp/**/*.ts',
        'src/acp/**/*.ts',
        'src/hooks/**/*.ts',
        'src/plugins/**/*.ts',
        'src/ui/**/*.{ts,tsx}',
        'src/agp/**/*.ts',
        'src/im/**/*.ts',
        'src/commands/**/*.ts',
        'src/metrics/**/*.ts',
      ],
      exclude: [
        'src/**/*.test.ts',
        'src/main.ts',
        'src/**/index.ts',
        'node_modules/**',
        'dist/**',
      ],
      thresholds: {
        statements: 60,
        branches: 50,
        functions: 60,
        lines: 60,
        // Security-critical modules: higher bar
        'src/permissions/**/*.ts': {
          statements: 75,
          branches: 65,
          functions: 75,
          lines: 75,
        },
        'src/services/sandbox*.ts': {
          statements: 65,
          branches: 55,
          functions: 65,
          lines: 65,
        },
        // Newly tracked modules (previously coverage blind spots): temporary
        // lower bar until dedicated tests are added; ratchet upward over time.
        'src/agp/**/*.ts': {
          statements: 40,
          branches: 35,
          functions: 40,
          lines: 40,
        },
        'src/im/**/*.ts': {
          statements: 40,
          branches: 35,
          functions: 40,
          lines: 40,
        },
        'src/commands/**/*.ts': {
          statements: 40,
          branches: 35,
          functions: 40,
          lines: 40,
        },
        'src/ui/**/*.tsx': {
          statements: 40,
          branches: 35,
          functions: 40,
          lines: 40,
        },
      },
    },
    testTimeout: 15000,
  },
});
