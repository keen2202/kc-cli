// Vitest wrapper - runs vitest programmatically
// The main test runner is now `npx vitest run` (see package.json "test" script)

import { startVitest } from 'vitest/node';

async function runTests() {
  console.log('Running kc-cli tests via vitest...\n');

  const vitest = await startVitest('run', [], {
    config: './vitest.config.ts',
  });

  await vitest?.close();

  if (vitest?.state.getCountOfFailedTests() ?? 0 > 0) {
    process.exit(1);
  }
}

runTests().catch((error) => {
  console.error('Test runner failed:', error);
  process.exit(1);
});
