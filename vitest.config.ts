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
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
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
      ],
      exclude: [
        'src/**/*.test.ts',
        'src/main.ts',
        'src/**/index.ts',
        'node_modules/**',
        'dist/**',
      ],
      thresholds: {
        statements: 70,
        branches: 60,
        functions: 70,
        lines: 70,
      },
    },
    testTimeout: 15000,
  },
});
