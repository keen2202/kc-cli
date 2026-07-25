// Contract tests for the hybrid LLM extraction tier (T2–T7).
//
// Every LLM interaction is dependency-injected, so these tests use a mock
// client and assert the BEHAVIOUR CONTRACT (call counts, fallback, telemetry,
// confidence grading, determinism) — never the wording of prompts or logs.
//
//   CT5  feedback signal → LLM called exactly once
//   CT6  ordinary turn (no trigger) → LLM not called
//   CT7  budget exceeded → skipped, client never called
//   CT8  semantically similar candidate → skipped (dedup)
//   CT9  recursion isolation → 1 chat call, post-turn hooks NOT fired
//   CT10 client error → silent degrade to heuristic, no throw, classified
//   CT11 three consecutive failures → circuit broken
//   CT12 confidence grading → LLM=high, heuristic=low
//   CT13 fixed mock output → deterministic, repeatable result
//   CT14 tier disabled → no LLM call, equivalent to pure heuristic

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  extractMemoriesHybrid,
  extractMemoriesFromMessages,
  shouldRunLlmExtraction,
  hasFeedbackSignal,
  resetExtractionState,
  type LlmExtractionClient,
} from '../../src/services/memoryExtraction';
import { getTelemetry, resetTelemetry } from '../../src/memory/telemetry';
import { DEFAULT_MEMORY_CONFIG } from '../../src/memory/protocol';
import type { MemoryConfig } from '../../src/memory/types';
import type { ChatMessage } from '../../src/query/protocol';
import { BudgetEnforcer } from '../../src/services/budget';
import {
  registerPostTurnHook,
  clearHooks,
  getHookCount,
} from '../../src/hooks/postTurnHooks';

// A valid extraction output the mock client will "produce".
const LLM_OUTPUT = [
  '---',
  'name: TS Strict Preference',
  'description: User prefers TypeScript strict mode',
  'type: user',
  '---',
  'The user prefers TypeScript strict mode for all backend services always.',
].join('\n');

function makeConfig(overrides: Partial<MemoryConfig> = {}): MemoryConfig {
  return {
    ...DEFAULT_MEMORY_CONFIG,
    llmExtraction: { enabled: true },
    ...overrides,
  };
}

function userMsg(content: string): ChatMessage {
  return { id: 'u1', role: 'user', content, timestamp: 1000 };
}

/** Mock client that resolves with a fixed extraction output. */
function makeClient(content: string = LLM_OUTPUT): LlmExtractionClient & { chat: ReturnType<typeof vi.fn> } {
  return {
    chat: vi.fn().mockResolvedValue({
      content,
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    }),
  };
}

/** Mock client that always rejects, to exercise the degrade path. */
function makeFailingClient(error: Error): LlmExtractionClient & { chat: ReturnType<typeof vi.fn> } {
  return { chat: vi.fn().mockRejectedValue(error) };
}

// A user turn that carries a feedback cue but produces NO heuristic entry
// (feedback patterns only match assistant turns), so LLM output stands alone.
const FEEDBACK_ONLY = 'remember to always keep the config simple and documented';
// A user turn matching the heuristic preference pattern AND a feedback cue.
const FEEDBACK_AND_HEURISTIC = 'I prefer using TypeScript strict mode for all backend services always';

describe('memory hybrid LLM extraction', () => {
  beforeEach(() => {
    resetExtractionState();
    resetTelemetry();
    clearHooks();
  });

  // ── CT5: feedback signal triggers exactly one LLM call ────────────────────
  it('CT5 — a feedback signal triggers exactly one LLM call', async () => {
    const client = makeClient();
    const result = await extractMemoriesHybrid([userMsg(FEEDBACK_ONLY)], {
      config: makeConfig(),
      client,
    });

    expect(client.chat).toHaveBeenCalledTimes(1);
    expect(result.some((e) => e.header.confidence === 'high')).toBe(true);
    expect(getTelemetry().llmExtractionCalls).toBe(1);
    expect(getTelemetry().memoriesFromLlm).toBe(1);
  });

  // ── CT6: an ordinary turn never reaches the LLM ───────────────────────────
  it('CT6 — an ordinary turn without a trigger does not call the LLM', async () => {
    const client = makeClient();
    const result = await extractMemoriesHybrid(
      [userMsg('The weather is nice today and I went for a walk outside.')],
      { config: makeConfig(), client }
    );

    expect(client.chat).not.toHaveBeenCalled();
    expect(result.every((e) => e.header.confidence === 'low')).toBe(true);
  });

  // ── CT7: budget gate skips extraction before spending anything ────────────
  it('CT7 — budget exceeded skips the call and the client is never invoked', async () => {
    const budget = new BudgetEnforcer({ subAgentTokenLimit: 1 });
    const client = makeClient();

    const result = await extractMemoriesHybrid([userMsg(FEEDBACK_AND_HEURISTIC)], {
      config: makeConfig(),
      client,
      budget,
    });

    expect(client.chat).not.toHaveBeenCalled();
    // Falls back to heuristic candidates (low confidence).
    expect(result.every((e) => e.header.confidence === 'low')).toBe(true);

    const decision = shouldRunLlmExtraction({
      newMessages: [userMsg(FEEDBACK_AND_HEURISTIC)],
      config: makeConfig(),
      hasClient: true,
      budget,
      estimatedTokens: 5000,
    });
    expect(decision.run).toBe(false);
    expect(decision.reason).toBe('budget_exceeded');
  });

  // ── CT8: semantic dedup skips paraphrased duplicates ──────────────────────
  it('CT8 — a semantically similar candidate is skipped by dedup', async () => {
    const client = makeClient();
    const similarity = vi.fn().mockReturnValue(1); // always "duplicate"

    const result = await extractMemoriesHybrid([userMsg(FEEDBACK_ONLY)], {
      config: makeConfig(),
      client,
      getExistingManifest: async () => [
        { fileName: 'existing.md', description: 'existing memory', type: 'user', mtime: 0 },
      ],
      similarity,
    });

    expect(result).toHaveLength(0);
    expect(getTelemetry().dedupSkipped).toBeGreaterThan(0);
    expect(similarity).toHaveBeenCalled();
  });

  it('CT8b — a dissimilar candidate is kept', async () => {
    const client = makeClient();
    const similarity = vi.fn().mockReturnValue(0); // never a duplicate

    const result = await extractMemoriesHybrid([userMsg(FEEDBACK_ONLY)], {
      config: makeConfig(),
      client,
      getExistingManifest: async () => [
        { fileName: 'existing.md', description: 'unrelated memory', type: 'user', mtime: 0 },
      ],
      similarity,
    });

    expect(result.length).toBeGreaterThan(0);
    expect(getTelemetry().dedupSkipped).toBe(0);
  });

  // ── CT9: recursion isolation ──────────────────────────────────────────────
  it('CT9 — the isolated extraction call fires exactly one chat and no post-turn hooks', async () => {
    const client = makeClient();
    const hookSpy = vi.fn().mockResolvedValue(undefined);
    registerPostTurnHook(hookSpy);
    expect(getHookCount()).toBe(1);

    await extractMemoriesHybrid([userMsg(FEEDBACK_ONLY)], { config: makeConfig(), client });

    // Exactly one call — the extraction agent cannot recursively re-trigger.
    expect(client.chat).toHaveBeenCalledTimes(1);
    // The isolated path bypasses the post-turn hook chain entirely.
    expect(hookSpy).not.toHaveBeenCalled();
  });

  it('CT9b — the isolated call goes direct: no tools and a temperature of 0', async () => {
    const client = makeClient();
    await extractMemoriesHybrid([userMsg(FEEDBACK_ONLY)], { config: makeConfig(), client });

    const request = client.chat.mock.calls[0][0];
    expect(request.tools).toBeUndefined();
    expect(request.temperature).toBe(0);
    expect(request.abortSignal).toBeDefined();
  });

  // ── CT10: client error degrades silently to heuristic ─────────────────────
  it('CT10 — a client error degrades to heuristic without throwing', async () => {
    const client = makeFailingClient(new Error('429 rate limit exceeded'));

    let result: Awaited<ReturnType<typeof extractMemoriesHybrid>> = [];
    await expect(
      (async () => {
        result = await extractMemoriesHybrid([userMsg(FEEDBACK_AND_HEURISTIC)], {
          config: makeConfig(),
          client,
        });
      })()
    ).resolves.toBeUndefined();

    expect(client.chat).toHaveBeenCalledTimes(1);
    // Heuristic fallback candidate survives (low confidence).
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((e) => e.header.confidence === 'low')).toBe(true);
    expect(getTelemetry().heuristicFallbacks).toBe(1);
  });

  it('CT10b — a timeout error also degrades gracefully', async () => {
    const client = makeFailingClient(new Error('request timed out'));
    const result = await extractMemoriesHybrid([userMsg(FEEDBACK_AND_HEURISTIC)], {
      config: makeConfig(),
      client,
    });
    expect(result.every((e) => e.header.confidence === 'low')).toBe(true);
    expect(getTelemetry().heuristicFallbacks).toBe(1);
  });

  // ── CT11: consecutive failures trip the circuit breaker ───────────────────
  it('CT11 — three consecutive failures trip the circuit breaker', async () => {
    const client = makeFailingClient(new Error('timeout'));
    const config = makeConfig();

    for (let i = 0; i < 3; i++) {
      await extractMemoriesHybrid([userMsg(`I prefer approach number ${i}, remember always`)], {
        config,
        client,
      });
    }

    expect(getTelemetry().circuitBroken).toBe(true);
    expect(client.chat).toHaveBeenCalledTimes(3);

    // Once broken, further turns short-circuit without calling the client.
    await extractMemoriesHybrid([userMsg('I prefer yet another approach, remember always')], {
      config,
      client,
    });
    expect(client.chat).toHaveBeenCalledTimes(3);
  });

  // ── CT12: confidence grading ──────────────────────────────────────────────
  it('CT12 — LLM candidates are high confidence, heuristic candidates are low', async () => {
    const client = makeClient();
    const result = await extractMemoriesHybrid([userMsg(FEEDBACK_AND_HEURISTIC)], {
      config: makeConfig(),
      client,
    });

    const llmEntry = result.find((e) => e.header.name === 'TS Strict Preference');
    const heuristicEntry = result.find((e) => e.header.name === 'user_preferences');

    expect(llmEntry).toBeDefined();
    expect(llmEntry!.header.confidence).toBe('high');
    expect(heuristicEntry).toBeDefined();
    expect(heuristicEntry!.header.confidence).toBe('low');
  });

  // ── CT13: determinism ──────────────────────────────────────────────────────
  it('CT13 — a fixed mock output yields a repeatable result', async () => {
    const now = () => 5000;

    const run = async () => {
      resetExtractionState();
      resetTelemetry();
      const client = makeClient();
      return extractMemoriesHybrid([userMsg(FEEDBACK_ONLY)], {
        config: makeConfig(),
        client,
        now,
      });
    };

    const first = await run();
    const second = await run();

    expect(first).toEqual(second);
    expect(first).toHaveLength(1);
    expect(first[0].fileName).toBe('ts_strict_preference_5000_0.md');
  });

  // ── CT14: disabled tier is a zero-cost no-op ──────────────────────────────
  it('CT14 — a disabled tier never calls the LLM and matches pure heuristic', async () => {
    const client = makeClient();
    const messages = [userMsg(FEEDBACK_AND_HEURISTIC)];

    const hybrid = await extractMemoriesHybrid(messages, {
      config: makeConfig({ llmExtraction: { enabled: false } }),
      client,
    });
    expect(client.chat).not.toHaveBeenCalled();

    // Byte-for-byte behavioural equivalence with the pure heuristic path
    // (ignoring the intentionally-random heuristic filename/mtime).
    resetExtractionState();
    const heuristic = await extractMemoriesFromMessages(messages);

    const project = (list: typeof hybrid) =>
      list.map((e) => ({
        name: e.header.name,
        type: e.header.type,
        confidence: e.header.confidence,
        content: e.content,
      }));

    expect(project(hybrid)).toEqual(project(heuristic));
  });

  // ── Session extraction cost cap (maxExtractionCostUsdPerSession, T6/§9) ───
  describe('session cost cap', () => {
    // One extraction call on this fixture costs ~$0.0047 (dominated by the
    // fixed 1536-token scaffold), so $0.005 sits between one and two calls.
    const CAP = 0.005;

    it('allows calls while under the cap and blocks once the cap is reached', async () => {
      const config = makeConfig({ maxExtractionCostUsdPerSession: CAP });
      const client = makeClient();

      // First call: projected spend (0 + ~0.0047) < cap → runs.
      await extractMemoriesHybrid([userMsg(FEEDBACK_ONLY)], { config, client });
      expect(client.chat).toHaveBeenCalledTimes(1);

      // Second call: projected spend (~0.0047 + ~0.0047) >= cap → skipped,
      // the client is NOT called again and the pipeline degrades to heuristic
      // (which finds nothing for this fixture → no LLM entries at all).
      const second = await extractMemoriesHybrid([userMsg(FEEDBACK_ONLY)], { config, client });
      expect(client.chat).toHaveBeenCalledTimes(1);
      expect(second.length).toBe(0);
      expect(getTelemetry().llmExtractionCalls).toBe(1);
    });

    it('reports session_cost_exceeded from the trigger decision', async () => {
      const config = makeConfig({ maxExtractionCostUsdPerSession: CAP });
      const client = makeClient();
      await extractMemoriesHybrid([userMsg(FEEDBACK_ONLY)], { config, client });

      const decision = shouldRunLlmExtraction({
        newMessages: [userMsg(FEEDBACK_ONLY)],
        config,
        hasClient: true,
        estimatedCostUsd: 0.001,
      });
      expect(decision).toEqual({ run: false, reason: 'session_cost_exceeded' });
    });

    it('reset clears the accumulated session spend', async () => {
      const config = makeConfig({ maxExtractionCostUsdPerSession: CAP });
      const client = makeClient();
      await extractMemoriesHybrid([userMsg(FEEDBACK_ONLY)], { config, client });

      resetExtractionState();

      const decision = shouldRunLlmExtraction({
        newMessages: [userMsg(FEEDBACK_ONLY)],
        config,
        hasClient: true,
        estimatedCostUsd: 0.001,
      });
      expect(decision.run).toBe(true);
    });

    it('no cap configured → unlimited (reason stays budget/trigger driven)', async () => {
      const config = makeConfig(); // maxExtractionCostUsdPerSession undefined
      const client = makeClient();

      for (let i = 0; i < 3; i++) {
        await extractMemoriesHybrid([userMsg(FEEDBACK_ONLY)], { config, client });
      }
      expect(client.chat).toHaveBeenCalledTimes(3);
    });
  });

  // ── shouldRunLlmExtraction / hasFeedbackSignal reason contract ────────────
  describe('trigger decision contract', () => {
    it('reports memory_disabled when memory is off', () => {
      const decision = shouldRunLlmExtraction({
        newMessages: [userMsg(FEEDBACK_ONLY)],
        config: makeConfig({ enabled: false }),
        hasClient: true,
      });
      expect(decision).toEqual({ run: false, reason: 'memory_disabled' });
    });

    it('reports llm_disabled when the tier is off', () => {
      const decision = shouldRunLlmExtraction({
        newMessages: [userMsg(FEEDBACK_ONLY)],
        config: makeConfig({ llmExtraction: { enabled: false } }),
        hasClient: true,
      });
      expect(decision).toEqual({ run: false, reason: 'llm_disabled' });
    });

    it('reports no_client when no client is available', () => {
      const decision = shouldRunLlmExtraction({
        newMessages: [userMsg(FEEDBACK_ONLY)],
        config: makeConfig(),
        hasClient: false,
      });
      expect(decision).toEqual({ run: false, reason: 'no_client' });
    });

    it('reports no_new_messages for an empty window', () => {
      const decision = shouldRunLlmExtraction({
        newMessages: [],
        config: makeConfig(),
        hasClient: true,
      });
      expect(decision).toEqual({ run: false, reason: 'no_new_messages' });
    });

    it('reports no_trigger for an ordinary turn', () => {
      const decision = shouldRunLlmExtraction({
        newMessages: [userMsg('just a normal message with nothing special')],
        config: makeConfig(),
        hasClient: true,
      });
      expect(decision).toEqual({ run: false, reason: 'no_trigger' });
    });

    it('runs on a feedback signal', () => {
      const decision = shouldRunLlmExtraction({
        newMessages: [userMsg(FEEDBACK_ONLY)],
        config: makeConfig(),
        hasClient: true,
      });
      expect(decision.run).toBe(true);
      expect(decision.reason).toBe('feedback_signal');
    });

    it('runs on an idle window even without a feedback cue', () => {
      const decision = shouldRunLlmExtraction({
        newMessages: [userMsg('an ordinary message body')],
        config: makeConfig(),
        hasClient: true,
        idleMs: DEFAULT_MEMORY_CONFIG.idleThresholdMinutes * 60_000,
      });
      expect(decision.run).toBe(true);
      expect(decision.reason).toBe('idle');
    });

    it('hasFeedbackSignal only inspects user turns', () => {
      expect(hasFeedbackSignal([userMsg('please remember this always')])).toBe(true);
      expect(hasFeedbackSignal([{ id: 'a', role: 'assistant', content: 'remember always', timestamp: 1 }])).toBe(
        false
      );
      expect(hasFeedbackSignal([userMsg('nothing notable here')])).toBe(false);
    });
  });
});
