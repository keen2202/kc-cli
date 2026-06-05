# Development Guide

Setup, conventions, and workflows for contributing to KC-CLI.

## Prerequisites

- Node.js 16.20.2+
- npm or yarn
- API key for at least one LLM provider

## Setup

```bash
# Clone
git clone <repo-url>
cd kc-cli

# Install
npm install

# Configure
cp .env.example .env
# Edit .env with your API key

# Verify
npm run typecheck
npm test
```

## Commands

| Command | Purpose |
|---------|---------|
| `npm run dev` | Development mode (tsx watch) |
| `npm run kc` | Start interactive REPL |
| `npm run typecheck` | Type check (tsc --noEmit) |
| `npm test` | Run tests (vitest) |
| `npm run test:watch` | Tests in watch mode |
| `npm run test:coverage` | Tests with coverage report |
| `npm run build` | Compile TypeScript to dist/ |

## Project Conventions

### TypeScript

- Strict mode enabled
- ES2022 target, ESNext modules
- Path alias: `@/*` → `src/*`
- No `any` types (reduced from 53 to 23 instances)
- Protocol-first: public types in `protocol.ts` per module

### Code Style

- No comments unless the WHY is non-obvious
- No multi-line docstrings
- Short, descriptive variable names
- Functions do one thing
- Prefer editing existing files over creating new ones

### Error Handling

- Use `Result<T, E>` for explicit error handling
- Use `KCError` with typed error codes
- Never swallow errors silently
- Wrap external errors in `KCError.fromApiError()`

### Testing

- Co-locate tests as `*.test.ts` next to source
- Integration tests in `test/` directory
- Use `MockLLMClient` for LLM-dependent tests
- Use `MockExecutionEnv` for tool tests
- Coverage thresholds: 60% lines, 50% branches, 60% functions

## Adding a New Tool

1. Create directory: `src/tools/MyTool/`
2. Create `index.ts` with tool definition:

```typescript
import { z } from 'zod';
import { buildTool } from '@/Tool';

const MyInputSchema = z.object({
  param: z.string().describe('Parameter description'),
});

export default buildTool({
  name: 'MyTool',
  description: 'What this tool does',
  inputSchema: MyInputSchema,
  isReadOnly: true,
  isConcurrencySafe: true,
  isDestructive: false,

  async call(input, context) {
    return { output: 'result' };
  },
});
```

3. Register in `src/tools.ts` -- add to `TOOL_MANIFEST` with priority
4. Add test: `src/tools/MyTool/index.test.ts`
5. Update tool table in README.md

## Adding a New LLM Provider

1. Create `src/api/NewProviderClient.ts` extending `BaseApiClient`
2. Implement `streamChat()`, `buildRequestBody()`, `formatMessages()`
3. Add provider to `src/api/index.ts` factory
4. Add provider config defaults
5. Add tests in `test/api/`

## Adding a New Plugin Contribution

1. Define contribution type in `src/plugins/protocol.ts`
2. Register in `src/plugins/plugin-manager.ts`
3. Wire into the appropriate system (tools, permissions, etc.)
4. Add tests in `test/plugins/`

## Architecture Patterns

### Protocol-First

Each module exports types in `protocol.ts`:

```
src/query/protocol.ts     -- QueryEngine public types
src/state/protocol.ts     -- State types and transitions
src/tools/protocol.ts     -- ToolDefinition interface
src/api/protocol.ts       -- LLM stream events
src/permissions/protocol.ts -- Permission types
```

### Result<T, E>

```typescript
import { ok, err, mapResult } from '@/utils/result';

const result = await riskyOperation();
if (result.ok) {
  // result.value is typed
} else {
  // result.error is typed
}
```

### ServiceContainer

Dependency injection with singleton/transient lifecycles:

```typescript
const container = new ServiceContainer();
container.registerSingleton('logger', () => new Logger());
container.registerTransient('toolExecutor', () => new ToolExecutor());

const logger = container.resolve('logger'); // Same instance
const executor = container.resolve('toolExecutor'); // New instance each time
```

### ExecutionEnv Abstraction

Tools use `ExecutionEnv` instead of direct FS/Shell access:

```typescript
interface ExecutionEnv {
  fs: FileSystem;
  shell: Shell;
}

// Production: LocalExecutionEnv (real FS + shell)
// Testing: MockExecutionEnv (in-memory)
```

## Debugging

```bash
# Verbose mode
npm run kc -- --verbose

# Startup profile
npm run kc -- --profile

# Type errors
npm run typecheck

# Specific test file
npx vitest run src/tools/BashTool/index.test.ts

# Coverage for specific module
npx vitest run --coverage src/query/
```

## Common Pitfalls

1. **Circular imports**: Use `protocol.ts` for types, not implementation files
2. **Missing sandbox markers**: Always use `ToolExecutor` for Bash/Run, never call directly
3. **Stale state**: Use `store.subscribe()` for reactive updates, not polling
4. **Token estimation**: Use `estimateTokens()` from `utils/tokenEstimation.ts`, not character counting
5. **Path security**: Always validate paths through `memory/paths.ts` or `utils/path.ts`
