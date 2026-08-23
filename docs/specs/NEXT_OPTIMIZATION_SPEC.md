# Next Optimization Phase - Specification Document

## Executive Summary

After completing performance optimization (+25-35%), cache hit rate optimization (95%+), and test coverage improvement (93%+), this document specifies the next phase of system improvements focusing on **type safety**, **API correctness**, **observability**, and **architecture cleanup**.

---

## Priority Matrix

| Priority | Area | Impact | Effort | Risk |
|----------|------|--------|--------|------|
| P0 | Schema Parameter Extraction | Critical | Medium | Low |
| P0 | Type Safety (any elimination) | High | High | Low |
| P1 | Structured Logging | High | Medium | Low |
| P1 | Error Handling Consistency | High | Medium | Low |
| P2 | Event System Consolidation | Medium | High | Medium |
| P2 | main.ts Decomposition | Medium | Medium | Low |
| P3 | Environment Validation | Medium | Low | Low |
| P3 | Plugin Sandboxing | Low | High | High |

---

## P0: Critical Improvements

### 1. Schema Parameter Extraction

**Problem:** `extractSchemaParameters` in `BaseApiClient.ts:179` is a stub returning empty schema. Tool schemas are never sent to the LLM, degrading tool use quality.

**Solution:** Implement Zod-to-JSON-Schema conversion.

**Files to modify:**
- `src/api/BaseApiClient.ts` - Implement `extractSchemaParameters`
- `src/tools/protocol.ts` - Ensure `inputSchema` is always Zod schema

**Acceptance Criteria:**
- [ ] All tool schemas are properly serialized to JSON Schema
- [ ] LLM receives complete tool definitions with parameter schemas
- [ ] Backward compatible with tools that don't define schemas

**Implementation:**
```typescript
// src/api/BaseApiClient.ts
import { zodToJsonSchema } from 'zod-to-json-schema';

protected extractSchemaParameters(tool: ToolDefinition): Record<string, unknown> {
  if (!tool.inputSchema) return { type: 'object', properties: {} };
  return zodToJsonSchema(tool.inputSchema, { target: 'openApi3' });
}
```

---

### 2. Type Safety - Eliminate `any` Types

**Problem:** 80+ instances of `any` types across the codebase, primarily in API clients, MCP transports, and tool implementations.

**Key areas:**

| File | Count | Description |
|------|-------|-------------|
| `api/AnthropicClient.ts` | 5 | Response parsing, stream events |
| `api/OpenAICompatibleClient.ts` | 2 | Response parsing |
| `api/OllamaClient.ts` | 3 | Response parsing |
| `utils/tokenEstimation.ts` | 4 | tiktoken encoder |
| `query/QueryEngine.ts` | 2 | Message building |
| `mcp/transports/*.ts` | 2 | SDK transport |
| `tools/SqlTool/index.ts` | 1 | Database connection |
| `executors/toolExecutor.ts` | 2 | Permission casting |

**Solution:** Create proper interfaces for each domain.

**New types to define:**
```typescript
// src/api/types.ts
interface ApiResponse {
  id: string;
  model: string;
  choices: Choice[];
  usage: TokenUsage;
}

interface StreamChunk {
  id: string;
  delta: Partial<Message>;
  finish_reason: string | null;
}

// src/utils/tiktoken.ts
interface TiktokenEncoder {
  encode(text: string): number[];
  free(): void;
}
```

**Acceptance Criteria:**
- [ ] Zero `any` types in `src/api/` directory
- [ ] Zero `any` types in `src/utils/tokenEstimation.ts`
- [ ] Zero `any` types in `src/mcp/transports/`
- [ ] All type assertions use explicit interfaces

---

## P1: High Priority Improvements

### 3. Structured Logging Framework

**Problem:** 152 raw `console.*` calls with manual `[ModuleName]` prefixes. No log levels, no structured fields, no correlation IDs.

**Solution:** Introduce lightweight `Logger` class.

**New file:** `src/services/logger.ts`

```typescript
interface LogEntry {
  level: 'debug' | 'info' | 'warn' | 'error';
  module: string;
  message: string;
  data?: Record<string, unknown>;
  timestamp: number;
  correlationId?: string;
}

class Logger {
  constructor(private module: string, private minLevel: LogLevel = 'info') {}

  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}
```

**Migration plan:**
1. Create Logger class with level filtering
2. Replace `console.log` → `logger.debug` or `logger.info`
3. Replace `console.warn` → `logger.warn`
4. Replace `console.error` → `logger.error`
5. Add `--log-level` CLI flag

**Acceptance Criteria:**
- [ ] All `console.*` calls replaced with Logger
- [ ] Log levels configurable via CLI flag
- [ ] Structured JSON output option for CI/CD
- [ ] Correlation ID propagation across async operations

---

### 4. Error Handling Consistency

**Problem:** 20+ empty catch blocks silently swallowing errors. Inconsistent error handling in API clients.

**Solution:**

**4a. Replace empty catch blocks:**
```typescript
// Before
try { ... } catch { }

// After
try { ... } catch (error) {
  logger.debug('Operation failed', { error, context: '...' });
}
```

**4b. Standardize API error handling:**
```typescript
// src/api/BaseApiClient.ts
protected handleApiError(error: unknown, response?: Response): never {
  const status = response?.status ?? extractStatusFromError(error);
  const message = error instanceof Error ? error.message : String(error);

  throw new ApiError(message, status, { cause: error });
}
```

**Files to modify:**
- `src/services/sandbox-profiles.ts` (4 instances)
- `src/services/consolidationScheduler.ts` (4 instances)
- `src/services/sandbox-probe.ts` (4 instances)
- `src/plugins/plugin-loader.ts` (4 instances)
- `src/api/AnthropicClient.ts`
- `src/api/OpenAICompatibleClient.ts`

**Acceptance Criteria:**
- [ ] Zero empty catch blocks in codebase
- [ ] All API errors use consistent `ApiError` class
- [ ] Error context preserved through the chain

---

## P2: Medium Priority Improvements

### 5. Event System Consolidation

**Problem:** Two parallel event type systems (`AgentEvent` and `StreamEvent`) with duplicated handling in `main.ts`.

**Solution:** Consolidate to single `StreamEvent` type.

**New unified type:**
```typescript
// src/state/events.ts
type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; id: string; output: string }
  | { type: 'thinking'; text: string }
  | { type: 'error'; error: string }
  | { type: 'done' };
```

**Migration:**
1. Define unified `StreamEvent` type
2. Update `QueryEngine.submitMessage` to yield only `StreamEvent`
3. Remove `AgentEvent` type and related handling
4. Simplify `handleStreamEvent` in `main.ts`

---

### 6. main.ts Decomposition

**Problem:** 574-line monolith with CLI setup, REPL logic, command handling, and stream event handling.

**Solution:** Extract into focused modules.

**New structure:**
```
src/cli/
  commands.ts      - Command handling (handleCommand)
  repl.ts          - REPL loop and input handling
  event-handler.ts - Stream event processing
  prompts.ts       - System prompt building
```

**Acceptance Criteria:**
- [ ] `main.ts` under 100 lines
- [ ] Each module has single responsibility
- [ ] All existing functionality preserved

---

## P3: Lower Priority Improvements

### 7. Environment Variable Validation

**Problem:** `loadEnvConfig` casts env vars without validation.

**Solution:**
```typescript
const PROVIDER_VALUES = ['anthropic', 'openai', 'deepseek', 'qwen', 'glm', 'ollama'] as const;
type Provider = typeof PROVIDER_VALUES[number];

function validateProvider(value: string): Provider {
  if (PROVIDER_VALUES.includes(value as Provider)) return value as Provider;
  throw new Error(`Invalid provider: ${value}. Must be one of: ${PROVIDER_VALUES.join(', ')}`);
}
```

---

### 8. CacheManager Interval Fix

**Problem:** `setInterval` prevents process exit.

**Solution:**
```typescript
// src/services/cache/CacheManager.ts
private constructor() {
  this.pruneInterval = setInterval(() => this.pruneAll(), 60_000);
  this.pruneInterval.unref(); // Don't prevent process exit
}
```

---

## Implementation Order

### Phase 1 (Week 1-2): Critical Fixes
1. Schema Parameter Extraction
2. Type Safety - API clients

### Phase 2 (Week 3-4): Observability
3. Structured Logging Framework
4. Error Handling Consistency

### Phase 3 (Week 5-6): Architecture
5. Event System Consolidation
6. main.ts Decomposition

### Phase 4 (Week 7): Polish
7. Environment Validation
8. CacheManager interval fix

---

## Success Metrics

| Metric | Current | Target |
|--------|---------|--------|
| `any` types | 80+ | 0 in core modules |
| Empty catch blocks | 20+ | 0 |
| console.* calls | 152 | 0 (replaced with Logger) |
| main.ts lines | 574 | <100 |
| Tool schema sent to LLM | No | Yes |
| Log level control | None | CLI flag |

---

## Dependencies

- `zod-to-json-schema` package for schema extraction
- No other external dependencies required

## Risks

- **Schema extraction**: May need custom serializer if Zod schemas use advanced features
- **Type safety**: Large refactor touching many files, needs comprehensive testing
- **Logging migration**: Mechanical but tedious, could miss edge cases

## Testing Strategy

- Unit tests for all new modules
- Integration tests for API client changes
- Snapshot tests for schema extraction output
- Manual testing for logging output formats
