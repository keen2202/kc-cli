// Shared harness for the de-watered QueryEngine orchestration tests
// (audit round3 T04 / C4).
//
// ARCHITECTURE NOTE (vitest 4): `vi.mock` registrations are kept INLINE in each
// QueryEngine-coverage*.test.ts file — mocks declared in an imported helper do
// not reliably reach every module instance in the graph. The helper therefore
// contains NO module mocks: only hoisted state, pure stream fixtures, tool
// factories and the engine factory.
//
// Mock policy after de-watering (applies to every consumer file):
//   - permissions/engine  → REAL (never mocked). resetHarness() arms
//     bypassPermissions + KC_ALLOW_BYPASS=1 so the genuine six-step deny-first
//     engine runs; protected paths / SSRF / policy-deny rules still deny.
//   - sandbox chain       → REAL except `sandbox-probe` (stubbed inline per
//     file). The probe runs host commands (bwrap escape checks) on
//     SandboxManager construction — environment-dependent cost, not decision
//     logic; policy/availability/wrap decisions stay real. No call-count
//     assertions are made on this stub (AGENTS.md Testing: mock ban).
//   - api / compaction / tokenEstimation remain preset-driven stubs: they are
//     non-security-critical inputs (LLM streams, token math) required for
//     deterministic orchestration tests.
//
// Tool side effects in converted cases land in a MockExecutionEnv
// (MockFileSystem/MockShell) captured by registered test tools, so assertions
// check behavior outcomes — never mock call counts on security-critical
// modules.
//
// Engine construction pins `sandboxFailIfNoSandbox: false` so environments
// without bwrap/docker fall back to noop deterministically instead of throwing
// in the QueryEngine constructor.

import { vi } from 'vitest';
import { z } from 'zod';

// ── Shared preset state ──
//
// Plain mutable state shared between each test file's vi.mock factories and
// the setters below. Accessors are plain functions (NOT vi.hoisted exports —
// vitest forbids exporting hoisted bindings, and the factories only ever call
// them lazily at request time, long after this module has evaluated).
//
// IMPORTANT for consumers: inline mock factories must call these accessors,
// e.g. `yield* getStreamFactory()()` and `getTokenEstimate()`.

interface HarnessState {
  /** Current LLM stream factory; swapped by setStream()/setCustomStreamChat(). */
  streamFactory: () => AsyncGenerator<any>;
  /** Preset token estimate consumed by the tokenEstimation stubs. */
  tokenEstimate: number;
}

const state: HarnessState = {
  streamFactory: () => (async function* () {})(),
  tokenEstimate: 1000,
};

/** Current stream factory — called by the inline api mock at request time. */
export function getStreamFactory(): () => AsyncGenerator<any> {
  return state.streamFactory;
}

/** Current token estimate — called by the inline tokenEstimation stubs. */
export function getTokenEstimate(): number {
  return state.tokenEstimate;
}

/** Swap the streamed LLM response for the next submitMessage turn(s). */
export function setStream(events: Array<Record<string, unknown>>) {
  state.streamFactory = async function* () {
    for (const event of events) { yield event; }
  };
}

/**
 * Full control over successive streamChat calls: each invocation pulls one
 * AsyncGenerator from `factory()`. Use for multi-round tool loops.
 */
export function setCustomStreamChat(factory: () => AsyncGenerator<any>) {
  state.streamFactory = factory;
}

/** Preset the token estimation result (drives auto-compaction thresholds). */
export function setTokenEstimate(value: number) {
  state.tokenEstimate = value;
}

/** Reset per-test mutable state (call after initializeState in beforeEach). */
export function resetHarnessState(): void {
  state.tokenEstimate = 1000;
  state.streamFactory = () => (async function* () {})();
}

// ── Stream fixtures ──

export interface StreamEventLike {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export function textEvents(text: string): StreamEventLike[] {
  return [{ type: 'text_delta', text }, { type: 'stop' }];
}

export function makeStream(events: StreamEventLike[]): AsyncGenerator<any> {
  return (async function* () {
    for (const event of events) { yield event; }
  })();
}

export function textStream(text: string): AsyncGenerator<any> {
  return makeStream(textEvents(text));
}

export function toolStream(text: string, toolCalls: Array<Record<string, unknown>>): AsyncGenerator<any> {
  return (async function* () {
    yield { type: 'text_delta', text };
    for (const tc of toolCalls) { yield { type: 'tool_use', toolCall: tc }; }
    yield { type: 'stop' };
  })();
}

export function makeToolCall(toolName: string, input: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `tc_${toolName}_${Math.random().toString(36).slice(2, 8)}`,
    toolName, input, status: 'pending',
  };
}

/** Alternate between two LLM turns: a first-turn generator, then final text. */
export function twoTurnStream(firstTurn: AsyncGenerator<any>, secondText: string) {
  let callCount = 0;
  setCustomStreamChat(() => {
    callCount++;
    return callCount === 1 ? firstTurn : textStream(secondText);
  });
}

// ── Tool factories (registered into the engine's REAL executor) ──

type CallFn = (input: any, ctx: any) => Promise<{ output: string; isError: boolean; metadata?: Record<string, unknown> }>;

/**
 * Build a minimal ToolDefinition for registration via createTestEngine's
 * second argument. Capture a MockExecutionEnv in the closure to observe side
 * effects without touching disk; permission/sandbox decisions stay REAL.
 */
export function makeTool(
  name: string,
  call: CallFn,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name,
    description: `test tool ${name}`,
    inputSchema: z.any(),
    call,
    ...overrides,
  };
}

/** Standard successful ToolResult. */
export function ok(output: string) {
  return { output, isError: false };
}

/** Standard failed ToolResult. */
export function fail(output: string) {
  return { output, isError: true };
}

// ── MockExecutionEnv plumbing ──

import { createMockExecutionEnv } from '../../../src/services/execution-env-mock';
import type { ExecutionEnv } from '../../../src/services/execution-env';
import type { MockFileSystem, MockShell } from '../../../src/services/execution-env-mock';

export function makeMockEnv(): { env: ExecutionEnv; fs: MockFileSystem; shell: MockShell } {
  const env = createMockExecutionEnv('/tmp/kc-dewater');
  return {
    env,
    fs: env.fs as MockFileSystem,
    shell: env.shell as MockShell,
  };
}

// ── Engine factory ──

import type { LLMProvider } from '../../../src/api';
import type { ToolDefinition } from '../../../src/tools/protocol';
import { QueryEngine } from '../../../src/query/QueryEngine';
import { initializeState } from '../../../src/bootstrap/state';

export interface TestEngineOverrides extends Record<string, any> {
  provider?: LLMProvider;
  apiKey?: string;
}

let savedBypassEnv: string | undefined;

/**
 * Reset bootstrap state for one test. Arms KC_ALLOW_BYPASS=1 so the REAL
 * engine honors the bypassPermissions mode (S3 gate); individual tests may
 * delete the env var to prove the gate denies without it.
 */
export function resetHarness(): void {
  if (savedBypassEnv === undefined) {
    savedBypassEnv = process.env.KC_ALLOW_BYPASS;
  }
  process.env.KC_ALLOW_BYPASS = '1';
  initializeState({ cwd: '/tmp', permissionMode: 'bypassPermissions' as any });
  vi.clearAllMocks();
  resetHarnessState();
}

/**
 * Create a QueryEngine over the REAL permission engine and REAL sandbox
 * decision layer. `extraTools` are registered into the real ToolExecutor so
 * streamed tool calls execute through genuine permission/sandbox decisions.
 */
export function createTestEngine(
  overrides: TestEngineOverrides = {},
  extraTools: ToolDefinition[] = [],
): QueryEngine {
  return new QueryEngine(
    {
      model: 'test-model',
      provider: 'openai' as LLMProvider,
      apiKey: 'test-key',
      maxTurns: 10,
      maxBudgetUsd: null,
      systemPrompt: 'You are helpful.',
      planningPhase: { enabled: false },
      patchGuarantee: { enabled: false },
      sandboxFailIfNoSandbox: false,
      ...overrides,
    },
    extraTools
  );
}

// ── Event collection ──

export async function collectEvents(engine: QueryEngine, message: string) {
  const events: any[] = [];
  for await (const event of engine.submitMessage(message)) {
    events.push(event);
  }
  return events;
}
