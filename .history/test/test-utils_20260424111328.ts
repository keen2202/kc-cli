// Test utilities

export interface TestResult {
  passed: number;
  failed: number;
  skipped: number;
  total: number;
}

let testResults: TestResult = {
  passed: 0,
  failed: 0,
  skipped: 0,
  total: 0,
};

export function describe(name: string, fn: () => void | Promise<void>): void {
  console.log(`\n📋 ${name}`);
  fn();
}

export async function it(name: string, fn: () => void | Promise<void>): Promise<void> {
  testResults.total++;
  try {
    await fn();
    testResults.passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    testResults.failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    Error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function expect(actual: unknown) {
  return {
    toBe(expected: unknown) {
      if (actual !== expected) {
        throw new Error(`Expected ${expected} but got ${actual}`);
      }
    },
    toEqual(expected: unknown) {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`Expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`);
      }
    },
    toBeGreaterThan(expected: number) {
      if (typeof actual !== 'number' || actual <= expected) {
        throw new Error(`Expected ${actual} to be greater than ${expected}`);
      }
    },
    toBeDefined() {
      if (actual === undefined) {
        throw new Error('Expected value to be defined');
      }
    },
    toBeTruthy() {
      if (!actual) {
        throw new Error('Expected value to be truthy');
      }
    },
    toBeFalsy() {
      if (actual) {
        throw new Error('Expected value to be falsy');
      }
    },
    toThrow() {
      if (typeof actual !== 'function') {
        throw new Error('Expected a function');
      }
      try {
        (actual as Function)();
        throw new Error('Expected function to throw');
      } catch {
        // Expected
      }
    },
  };
}

export function getTestResults(): TestResult {
  return { ...testResults };
}

export function resetTestResults(): void {
  testResults = { passed: 0, failed: 0, skipped: 0, total: 0 };
}

export function printTestSummary(): void {
  const { passed, failed, skipped, total } = testResults;
  console.log('\n' + '='.repeat(50));
  console.log(`Tests: ${total} total, ${passed} passed, ${failed} failed, ${skipped} skipped`);

  if (failed > 0) {
    console.log(chalk.red('\n❌ Some tests failed'));
    process.exit(1);
  } else {
    console.log(chalk.green('\n✅ All tests passed'));
  }
}

// Import chalk for summary
import chalk from 'chalk';
