# Testing

Vitest-based test suite with 3899 tests across 178 files, mock utilities, and co-located test patterns.

## Framework

- **Runner**: Vitest 4.1 with globals enabled
- **Coverage**: v8 provider
- **Thresholds**: Lines 60%, Branches 50%, Functions 60%, Statements 60%

## Commands

```bash
npm test               # Run all tests
npm run test:watch     # Watch mode
npm run test:coverage  # With coverage report
npm run test:ci        # CI mode (coverage + verbose)
```

## Test Locations

Tests are co-located with source code as `*.test.ts` files:

```
src/
  tools/
    BashTool/
      index.ts
      index.test.ts       ← co-located test
  permissions/
    engine.ts
    engine.test.ts        ← co-located test
```

Integration tests are in the `test/` directory, mirroring `src/` structure:

```
test/
  integration/
    full-workflow.test.ts
    multi-agent.test.ts
    sandbox-e2e.test.ts
    lsp-e2e.test.ts
  query/
    QueryEngine.test.ts
    steering.test.ts
  tools/
    BashTool.test.ts
    FileReadTool.test.ts
```

## Mock Utilities

### MockLLMClient

`test/test-utils.ts`:

```typescript
const mockLLM = new MockLLMClient();

// Preset responses
mockLLM.setResponse('Hello', { text: 'Hi there!' });

// Error injection
mockLLM.setError(new Error('API rate limit'));

// Streaming simulation
mockLLM.setStreamResponse([
  { type: 'text_delta', text: 'Hello ' },
  { type: 'text_delta', text: 'world' },
  { type: 'done' },
]);

// Usage tracking
expect(mockLLM.totalTokensUsed).toBe(150);
```

### MockFileSystem + MockShell

`src/services/execution-env-mock.ts`:

```typescript
const mockFS = new MockFileSystem();
const mockShell = new MockShell();
const mockEnv = new MockExecutionEnv(mockFS, mockShell);

// Preset file contents
mockFS.setFile('/src/index.ts', 'export const x = 1;');

// Track operations
expect(mockFS.writtenFiles.get('/src/index.ts')).toBe('new content');

// Shell responses
mockShell.setResponse('npm test', { stdout: 'All tests passed', exitCode: 0 });
```

### Test Fixtures

`test/fixtures.ts`:

Shared test data:
- Sample chat messages
- Tool call fixtures
- Config snapshots
- Memory entries

## Test Patterns

### Tool Testing

```typescript
describe('BashTool', () => {
  it('executes simple commands', async () => {
    const tool = createBashTool(mockEnv);
    const result = await tool.call(
      { command: 'echo hello' },
      mockContext
    );
    expect(result.output).toContain('hello');
  });

  it('respects timeout', async () => {
    const tool = createBashTool(mockEnv);
    await expect(
      tool.call({ command: 'sleep 10', timeout: 1 }, mockContext)
    ).rejects.toThrow('timeout');
  });
});
```

### State Machine Testing

```typescript
describe('AgentStateMachine', () => {
  it('validates transitions', () => {
    const machine = new AgentStateMachine();
    expect(machine.transition('idle', 'compacting')).toBe(true);
    expect(() => machine.transition('idle', 'streaming')).toThrow();
  });
});
```

### Permission Testing

```typescript
describe('PermissionEngine', () => {
  it('denies first in deny-first flow', async () => {
    const engine = createPermissionEngine({
      alwaysDenyRules: [{ tool: 'Bash', pattern: 'rm *' }],
    });
    const result = await engine.check('Bash', { command: 'rm -rf /' }, 'default');
    expect(result.decision).toBe('deny');
  });
});
```

### Integration Testing

```typescript
describe('Full Workflow', () => {
  it('processes message through complete pipeline', async () => {
    const mockLLM = new MockLLMClient();
    mockLLM.setStreamResponse([
      { type: 'tool_use', id: '1', name: 'Bash', input: '{"command":"ls"}' },
      { type: 'text_delta', text: 'Listed files' },
      { type: 'done' },
    ]);

    const engine = createQueryEngine({ llm: mockLLM, tools: [bashTool] });
    const events = [];
    for await (const event of engine.submitMessage('List files')) {
      events.push(event);
    }

    expect(events.some(e => e.type === 'tool_use')).toBe(true);
    expect(events.some(e => e.type === 'text_delta')).toBe(true);
  });
});
```

## Coverage Report

```
Statements   : 92.3% ( threshold: 60% )
Branches     : 84.8% ( threshold: 50% )
Functions    : 93.6% ( threshold: 60% )
Lines        : 92.9% ( threshold: 60% )
```

## Test Isolation

- Each test file gets a fresh module context
- `beforeEach` resets shared state (stores, registries)
- Mock utilities are per-test, not shared
- No test-to-test dependencies
