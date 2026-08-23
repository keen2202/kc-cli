// Behavior tests for the QueryEngine TurnControl submodule (audit round3 T13 / H6).
//
// Scope: `src/query/QueryEngineTurnControl.ts` (`afterStreamingTurn`) — the
// post-streaming cross-turn orchestration: progress signals, importance
// tagging + read/edit history, phase steers, progress checkpoints, periodic
// auto-commit, anti-abandonment steers and turn-budget extension; plus the
// steer/followUp queue drain timing of the surrounding engine loop.
//
// The module under test is driven REAL: `afterStreamingTurn` runs against real
// ConversationState / FileContentCache / ImportanceTagger. Only git is mocked
// (`utils/git.autoCommitAll`) so no real commit is ever attempted, and the LLM
// transport is injected through MockLLMClient for the end-to-end drain-timing
// test. No network, no real git.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { afterStreamingTurn, type TurnBudget, type TurnControlDeps } from '../../src/query/QueryEngineTurnControl';
import { ConversationState } from '../../src/query/QueryEngineState';
import { FileContentCache } from '../../src/services/cache/FileContentCache';
import { ImportanceTagger } from '../../src/query/QueryEngineImportance';
import { initializeState } from '../../src/bootstrap/state';
import type { AgentEvent } from '../../src/state/types';
import type { AssistantMessage, ChatMessage } from '../../src/query/protocol';

const gitMock = vi.hoisted(() => ({
  autoCommitAll: vi.fn(),
}));

vi.mock('../../src/utils/git', () => ({
  autoCommitAll: gitMock.autoCommitAll,
  parseGitArgs: vi.fn((command: string) => command.split(' ')),
  spawnGit: vi.fn(async () => ({ stdout: '', stderr: '' })),
  isInsideGitRepo: vi.fn(async () => false),
  resetGitWarnDebounce: vi.fn(),
  autoStageFile: vi.fn(async () => undefined),
  getModifiedFiles: vi.fn(async () => []),
}));

// LLM transport seam for the end-to-end drain-timing suite below: the engine's
// createAPIClient() is redirected to whatever MockLLMClient the test installs.
const { clientRef } = vi.hoisted(() => ({
  clientRef: { current: null as unknown | null },
}));

vi.mock('../../src/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/api')>();
  return {
    ...actual,
    createAPIClient: vi.fn(() => clientRef.current),
  };
});

// ── Fixtures ──

let msgCounter = 0;
function assistantMsg(content: string | null, toolCalls?: AssistantMessage['toolCalls']): AssistantMessage {
  return {
    id: `assistant_${++msgCounter}`,
    role: 'assistant',
    content,
    ...(toolCalls ? { toolCalls } : {}),
    timestamp: Date.now(),
  };
}

function userMsg(content: string): ChatMessage {
  return { id: `user_${++msgCounter}`, role: 'user', content, timestamp: Date.now() };
}

function toolMsg(outputs: string[]): ChatMessage {
  return {
    id: `tool_${++msgCounter}`,
    role: 'tool',
    content: null,
    toolResults: outputs.map((output, i) => ({ toolCallId: `c${i}`, output, isError: false })),
    timestamp: Date.now(),
  };
}

function toolCall(id: string, toolName = 'read'): NonNullable<AssistantMessage['toolCalls']>[number] {
  return { id, toolName, input: {}, status: 'completed' };
}

interface DepsSpec {
  messages?: ChatMessage[];
  conversational?: boolean;
  importanceTagging?: boolean;
  autoCommitInterval?: number;
  minTurns?: number;
  modifiedFiles?: string[];
  lastModifiedTurn?: number;
  lastProgressTurn?: number;
  maxTurns?: number;
  maxTurnsCeiling?: number;
  autoExtend?: boolean;
}

function makeFixture(spec: DepsSpec = {}) {
  const conversation = new ConversationState();
  const messages = spec.messages ?? [];
  for (const m of messages) conversation.addMessage(m);

  const readHistory = new Map<string, number>();
  const editHistory = new Map<string, number>();
  const modifiedFiles = new Set<string>(spec.modifiedFiles ?? []);
  const progress = {
    lastModifiedTurn: spec.lastModifiedTurn ?? 0,
    lastProgressTurn: spec.lastProgressTurn ?? 0,
  };
  const fileContentCache = new FileContentCache();
  const steers: string[] = [];

  const deps: TurnControlDeps = {
    conversation,
    fileContentCache,
    importanceTagger: new ImportanceTagger(),
    readHistory,
    editHistory,
    modifiedFiles,
    progress,
    conversational: spec.conversational ?? false,
    importanceTagging: spec.importanceTagging ?? false,
    autoCommitInterval: spec.autoCommitInterval ?? 0,
    minTurns: spec.minTurns ?? 0,
    cwd: '/mock-project',
    steer: (m) => { steers.push(m); },
  };

  const budget: TurnBudget = {
    maxTurns: spec.maxTurns ?? 20,
    maxTurnsCeiling: spec.maxTurnsCeiling ?? 100,
    autoExtend: spec.autoExtend ?? false,
  };

  async function run(turnCount: number): Promise<AgentEvent[]> {
    const events: AgentEvent[] = [];
    for await (const ev of afterStreamingTurn(deps, turnCount, budget)) {
      events.push(ev as AgentEvent);
    }
    return events;
  }

  return { deps, budget, run, steers, conversation, progress, readHistory, editHistory, modifiedFiles, fileContentCache };
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

// ── Tests ──

/** Joined text of all agent:text_delta events (typed narrowing, no `any`). */
function deltaTexts(events: readonly AgentEvent[]): string {
  return events
    .filter((e): e is Extract<AgentEvent, { type: 'agent:text_delta' }> => e.type === 'agent:text_delta')
    .map(e => e.text)
    .join('');
}

describe('afterStreamingTurn — progress signal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gitMock.autoCommitAll.mockResolvedValue(false);
  });

  it('marks a tool-issuing turn as recent progress even with no file edits', async () => {
    const fx = makeFixture({
      messages: [userMsg('explore'), assistantMsg('looking around', [toolCall('c1')])],
    });
    await fx.run(3);
    expect(fx.progress.lastProgressTurn).toBe(3);
  });

  it('does not mark a text-only assistant turn as tool progress', async () => {
    const fx = makeFixture({ messages: [userMsg('hi'), assistantMsg('plain answer')] });
    await fx.run(3);
    expect(fx.progress.lastProgressTurn).toBe(0);
  });
});

describe('afterStreamingTurn — importance tagging and read/edit history', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gitMock.autoCommitAll.mockResolvedValue(false);
  });

  it('tags the last assistant message and advances the cache turn cursor', async () => {
    const fx = makeFixture({
      importanceTagging: true,
      messages: [
        userMsg('read the parser'),
        toolMsg(['parser output line']),
        assistantMsg('The parser lives in src/parser/index.ts'),
      ],
    });
    await fx.run(7);

    const lastAssistant = fx.conversation.getLastMessage() as AssistantMessage;
    const tag = fx.conversation.getTag(lastAssistant.id);
    expect(tag).toBeDefined();
    expect(tag!.importance).toBe('exploration');
    expect(tag!.filePaths).toContain('src/parser/index.ts');

    // setTurn(7) is observable: entries cached now remember turn 7.
    expect(fx.fileContentCache.check('src/parser/index.ts', 'content')).toBe('fresh');
    expect(fx.fileContentCache.check('src/parser/index.ts', 'content')).toEqual({ cachedSince: 7 });
  });

  it('classifies turns with failing test output as key_finding from tool results', async () => {
    const fx = makeFixture({
      importanceTagging: true,
      messages: [
        userMsg('run tests'),
        toolMsg(['FAILED tests/test_a.py::test_one - AssertionError']),
        assistantMsg('tests are failing'),
      ],
    });
    await fx.run(2);
    const last = fx.conversation.getLastMessage() as AssistantMessage;
    expect(fx.conversation.getTag(last.id)?.importance).toBe('key_finding');
  });

  it('records read history for files touched without write/edit tools', async () => {
    const fx = makeFixture({
      importanceTagging: true,
      messages: [userMsg('look'), assistantMsg('reading src/app/main.ts', [toolCall('c1', 'read')])],
    });
    await fx.run(4);
    expect(fx.readHistory.get('src/app/main.ts')).toBe(4);
    expect(fx.editHistory.size).toBe(0);
  });

  it('routes edited files to edit history and invalidates their cached content', async () => {
    const filePath = 'src/app/main.ts';
    const fx = makeFixture({
      importanceTagging: true,
      messages: [assistantMsg(`editing ${filePath}`, [toolCall('c1', 'edit')])],
    });
    // Prime the cache so invalidation is observable.
    expect(fx.fileContentCache.check(filePath, 'old content')).toBe('fresh');

    await fx.run(5);

    expect(fx.editHistory.get(filePath)).toBe(5);
    expect(fx.readHistory.has(filePath)).toBe(false);
    // Invalidate removed the primed entry → next check is fresh again.
    expect(fx.fileContentCache.check(filePath, 'old content')).toBe('fresh');

    const last = fx.conversation.getLastMessage() as AssistantMessage;
    expect(fx.conversation.getTag(last.id)?.applied).toBe(true);
  });

  it('skips tagging entirely when importanceTagging is disabled', async () => {
    const fx = makeFixture({
      importanceTagging: false,
      messages: [assistantMsg('reading src/app/main.ts', [toolCall('c1', 'edit')])],
    });
    await fx.run(2);
    const last = fx.conversation.getLastMessage() as AssistantMessage;
    expect(fx.conversation.getTag(last.id)).toBeUndefined();
    expect(fx.readHistory.size).toBe(0);
    expect(fx.editHistory.size).toBe(0);
  });
});

describe('afterStreamingTurn — phase steers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gitMock.autoCommitAll.mockResolvedValue(false);
  });

  it('injects the Phase 1 planning steer on turn 1 of a long task', async () => {
    const fx = makeFixture({ maxTurns: 20, messages: [assistantMsg('starting')] });
    await fx.run(1);
    expect(fx.steers).toHaveLength(1);
    expect(fx.steers[0]).toContain('[Phase 1 - Planning]');
  });

  it('suppresses the Phase 1 steer when the budget is small (boundary >10)', async () => {
    const small = makeFixture({ maxTurns: 10, messages: [assistantMsg('ok')] });
    await small.run(1);
    expect(small.steers).toHaveLength(0);

    const justOver = makeFixture({ maxTurns: 11, messages: [assistantMsg('ok')] });
    await justOver.run(1);
    expect(justOver.steers.some(s => s.includes('[Phase 1 - Planning]'))).toBe(true);
  });

  it('never injects phase steers on conversational queries', async () => {
    const fx = makeFixture({ conversational: true, maxTurns: 20, messages: [assistantMsg('hello!')] });
    await fx.run(1);
    expect(fx.steers).toHaveLength(0);
  });

  it('injects the Phase 3 verification steer exactly at maxTurns - 5', async () => {
    const atBoundary = makeFixture({ maxTurns: 20, messages: [assistantMsg('working')] });
    await atBoundary.run(15);
    expect(atBoundary.steers.some(s => s.includes('[Phase 3 - Verification]'))).toBe(true);

    const pastBoundary = makeFixture({ maxTurns: 20, messages: [assistantMsg('working')] });
    await pastBoundary.run(16);
    expect(pastBoundary.steers.some(s => s.includes('[Phase 3 - Verification]'))).toBe(false);
  });

  it('suppresses the Phase 3 steer on conversational queries', async () => {
    const fx = makeFixture({ conversational: true, maxTurns: 20, messages: [assistantMsg('sure')] });
    await fx.run(15);
    expect(fx.steers).toHaveLength(0);
  });
});

describe('afterStreamingTurn — progress checkpoints', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gitMock.autoCommitAll.mockResolvedValue(false);
  });

  it('appends a checkpoint message every 10 turns when files were modified', async () => {
    const fx = makeFixture({ maxTurns: 20, modifiedFiles: ['src/a.ts', 'src/b.ts'], messages: [assistantMsg('working')] });
    await fx.run(10);

    const all = fx.conversation.getMessages();
    const checkpoint = all[all.length - 1];
    expect(checkpoint.role).toBe('user');
    expect(checkpoint.content).toContain('[Progress Checkpoint - Turn 10/20]');
    expect(checkpoint.content).toContain('- src/a.ts');
    expect(checkpoint.content).toContain('- src/b.ts');
    expect(checkpoint.content).toContain('You have 10 turns remaining');
  });

  it('emits no checkpoint when nothing was modified or the turn is not a multiple of 10', async () => {
    const noFiles = makeFixture({ maxTurns: 20, messages: [assistantMsg('research only')] });
    await noFiles.run(10);
    // Conversation unchanged: still just the seeded assistant message.
    expect(noFiles.conversation.getMessages()).toHaveLength(1);
    expect(noFiles.conversation.getLastMessage()?.role).toBe('assistant');

    const offCycle = makeFixture({ maxTurns: 20, modifiedFiles: ['src/a.ts'], messages: [assistantMsg('working')] });
    await offCycle.run(12);
    expect(offCycle.conversation.getMessages()).toHaveLength(1);
  });
});

describe('afterStreamingTurn — periodic auto-commit (P0)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gitMock.autoCommitAll.mockResolvedValue(true);
  });

  it('auto-commits on the configured interval and yields a visible checkpoint event', async () => {
    const fx = makeFixture({ autoCommitInterval: 5 });
    const events = await fx.run(10);

    expect(gitMock.autoCommitAll).toHaveBeenCalledTimes(1);
    expect(gitMock.autoCommitAll).toHaveBeenCalledWith('/mock-project', expect.stringContaining('checkpoint at turn 10'));
    const texts = deltaTexts(events);
    expect(texts).toContain('[Auto-commit checkpoint at turn 10]');
  });

  it('does not auto-commit when disabled or off-cycle', async () => {
    const disabled = makeFixture({ autoCommitInterval: 0 });
    await disabled.run(10);
    expect(gitMock.autoCommitAll).not.toHaveBeenCalled();

    const offCycle = makeFixture({ autoCommitInterval: 5 });
    await offCycle.run(7);
    expect(gitMock.autoCommitAll).not.toHaveBeenCalled();
  });

  it('yields no checkpoint event when there was nothing to commit', async () => {
    gitMock.autoCommitAll.mockResolvedValue(false);
    const fx = makeFixture({ autoCommitInterval: 5 });
    const events = await fx.run(5);
    expect(gitMock.autoCommitAll).toHaveBeenCalledTimes(1);
    expect(events.filter(e => e.type === 'agent:text_delta')).toHaveLength(0);
  });

  it('a failing git commit never interrupts the turn — later bookkeeping still runs', async () => {
    gitMock.autoCommitAll.mockRejectedValue(new Error('git: fatal not a git repository'));
    const fx = makeFixture({
      autoCommitInterval: 5,
      minTurns: 8,
      messages: [assistantMsg('done for now')], // text-only → anti-abandonment applies
    });
    // Must resolve (not throw) despite the git rejection…
    const events = await fx.run(5);
    expect(gitMock.autoCommitAll).toHaveBeenCalledTimes(1);
    // …and the anti-abandonment steer AFTER the failed commit still fired,
    // proving the turn continued to its normal end-of-turn bookkeeping.
    expect(fx.steers.some(s => s.includes('[Anti-Abandonment]'))).toBe(true);
    expect(events.every(e => e.type !== 'agent:error')).toBe(true);
  });
});

describe('afterStreamingTurn — anti-abandonment steer (P1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gitMock.autoCommitAll.mockResolvedValue(false);
  });

  it('nudges the agent when it tries to exit before minTurns', async () => {
    const fx = makeFixture({ minTurns: 5, messages: [userMsg('task'), assistantMsg('I am finished')] });
    await fx.run(2);
    expect(fx.steers).toHaveLength(1);
    expect(fx.steers[0]).toContain('[Anti-Abandonment]');
    expect(fx.steers[0]).toContain('at least 3 more turns');
  });

  it('does not nudge when the agent is still issuing tool calls', async () => {
    const fx = makeFixture({ minTurns: 5, messages: [assistantMsg('still going', [toolCall('c1')])] });
    await fx.run(2);
    expect(fx.steers).toHaveLength(0);
  });

  it('exempts conversational queries and zero minTurns configs', async () => {
    const conversational = makeFixture({
      conversational: true,
      minTurns: 5,
      messages: [assistantMsg('hi there')],
    });
    await conversational.run(2);
    expect(conversational.steers).toHaveLength(0);

    const noMinimum = makeFixture({ minTurns: 0, messages: [assistantMsg('done')] });
    await noMinimum.run(2);
    expect(noMinimum.steers).toHaveLength(0);
  });
});

describe('afterStreamingTurn — turn-budget extension at exhaustion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gitMock.autoCommitAll.mockResolvedValue(true);
  });

  it('extends by +20 when auto-extend is on and file edits are recent', async () => {
    const fx = makeFixture({
      maxTurns: 20,
      maxTurnsCeiling: 100,
      autoExtend: true,
      modifiedFiles: ['src/a.ts'],
      lastModifiedTurn: 17, // 20 - 17 < 5 → recent
      messages: [assistantMsg('still editing')],
    });
    const events = await fx.run(20);

    expect(fx.budget.maxTurns).toBe(40);
    const texts = deltaTexts(events);
    expect(texts).toContain('[Extended turn budget to 40');
    // Extension replaces the exhaustion path: no forced commit, no stop event.
    expect(gitMock.autoCommitAll).not.toHaveBeenCalled();
    expect(texts).not.toContain('maximum turn limit');
  });

  it('extends based on recent tool activity even with zero file edits', async () => {
    const fx = makeFixture({
      maxTurns: 20,
      maxTurnsCeiling: 100,
      autoExtend: true,
      lastProgressTurn: 19, // research-heavy but actively calling tools
      messages: [assistantMsg('reading more', [toolCall('c1')])],
    });
    await fx.run(20);
    expect(fx.budget.maxTurns).toBe(40);
  });

  it('stops when progress is stale (last modification ≥5 turns ago)', async () => {
    const fx = makeFixture({
      maxTurns: 20,
      maxTurnsCeiling: 100,
      autoExtend: true,
      modifiedFiles: ['src/a.ts'],
      lastModifiedTurn: 15, // 20 - 15 == 5 → NOT recent
      messages: [assistantMsg('stuck')],
    });
    const events = await fx.run(20);
    expect(fx.budget.maxTurns).toBe(20); // unchanged
    const texts = deltaTexts(events);
    expect(texts).toContain('[Reached maximum turn limit (20)');
  });

  it('caps the extension at maxTurnsCeiling', async () => {
    const fx = makeFixture({
      maxTurns: 90,
      maxTurnsCeiling: 95,
      autoExtend: true,
      modifiedFiles: ['src/a.ts'],
      lastModifiedTurn: 89,
      messages: [assistantMsg('almost done')],
    });
    const events = await fx.run(90);
    expect(fx.budget.maxTurns).toBe(95);
    const texts = deltaTexts(events);
    expect(texts).toContain('[Extended turn budget to 95');
  });

  it('stops when the ceiling has already been reached despite active progress', async () => {
    const fx = makeFixture({
      maxTurns: 50,
      maxTurnsCeiling: 50,
      autoExtend: true,
      modifiedFiles: ['src/a.ts'],
      lastModifiedTurn: 49,
      messages: [assistantMsg('busy')],
    });
    const events = await fx.run(50);
    expect(fx.budget.maxTurns).toBe(50);
    const texts = deltaTexts(events);
    expect(texts).toContain('[Reached maximum turn limit (50)');
  });

  it('stops when auto-extension is disabled', async () => {
    const fx = makeFixture({
      maxTurns: 20,
      autoExtend: false,
      modifiedFiles: ['src/a.ts'],
      lastModifiedTurn: 19,
      messages: [assistantMsg('done')],
    });
    await fx.run(20);
    expect(fx.budget.maxTurns).toBe(20);
  });

  describe('stop-path auto-commit on exhaustion', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      gitMock.autoCommitAll.mockResolvedValue(true);
    });

    it('commits pending work and reports the committed file count', async () => {
      const fx = makeFixture({
        maxTurns: 20,
        modifiedFiles: ['src/a.ts', 'src/b.ts'],
        messages: [assistantMsg('out of turns')],
      });
      const events = await fx.run(20);
      expect(gitMock.autoCommitAll).toHaveBeenCalledWith('/mock-project');
      const texts = deltaTexts(events);
      expect(texts).toContain('[Auto-committed 2 modified file(s)]');
    });

    it('stays silent when there was nothing to commit, and survives git failures', async () => {
      gitMock.autoCommitAll.mockResolvedValue(false);
      const quiet = makeFixture({ maxTurns: 20, modifiedFiles: ['src/a.ts'], messages: [assistantMsg('done')] });
      const quietEvents = await quiet.run(20);
      expect(deltaTexts(quietEvents).includes('Auto-committed')).toBe(false);

      gitMock.autoCommitAll.mockRejectedValue(new Error('git unavailable'));
      const failing = makeFixture({ maxTurns: 20, modifiedFiles: ['src/a.ts'], messages: [assistantMsg('done')] });
      // Non-fatal: the generator completes instead of throwing.
      const failingEvents = await collect(afterStreamingTurn(failing.deps, 20, failing.budget));
      expect(failingEvents.length).toBeGreaterThan(0);
    });
  });
});

// ── Steer/followUp queue drain timing through the real engine loop ──

describe('TurnControl context — steer/followUp queue drain timing (real QueryEngine)', () => {
  // The queues live on the QueryEngine facade; this suite drives the real loop
  // (real state machine, real sub-modules) with only the LLM transport replaced
  // by MockLLMClient and git stubbed, then enqueues inputs MID-TURN and asserts
  // they are processed at the safe points (steer → after executing; followUp →
  // after the deciding phase ends the turn).

  beforeEach(() => {
    initializeState({
      cwd: '/tmp',
      apiKey: 'test-key',
      permissionMode: 'bypassPermissions',
    });
    process.env.KC_API_KEY = 'test-dummy-key';
    vi.clearAllMocks();
    gitMock.autoCommitAll.mockResolvedValue(false);
  });

  it('drains queued steers after execution and follow-ups at turn completion', async () => {
    const { QueryEngine } = await import('../../src/query/QueryEngine');
    const { MockLLMClient } = await import('../utils/mock-llm');

    const llm = new MockLLMClient();
    llm.setResponses([
      { content: '', toolCalls: [{ id: 'call_1', toolName: 'Bash', input: { command: 'echo hi' }, status: 'pending' }] },
      { content: 'work finished' },
    ]);
    clientRef.current = llm;

    const engine = new QueryEngine(
      {
        model: 'test-model',
        provider: 'anthropic' as import('../../src/api').LLMProvider,
        apiKey: 'test-key',
        maxTurns: 10,
        maxBudgetUsd: null,
        // The main-loop drain points under test live in streaming→deciding→
        // executing; the (default-on) strategic planning phase would intercept
        // the first turns and strip tool calls, so it is disabled here.
        planningPhase: { enabled: false, maxTurns: 3, exemptFromBudget: true },
        patchGuarantee: {
          enabled: false,
          maxZeroPatchRetries: 3,
          maxVerificationRetries: 2,
          verificationTimeout: 60,
          testCommand: 'pytest {test_names} -x',
          typeCheck: false,
          typeCheckCommand: '',
          maxTypeCheckRetries: 2,
        },
      },
      []
    );

    const events: Array<import('../../src/query/protocol').StreamEvent | AgentEvent> = [];
    let steerEnqueued = false;
    let followUpEnqueued = false;

    for await (const ev of engine.submitMessage('Fix the parser bug in module core please')) {
      events.push(ev);
      if (ev.type === 'agent:turn_complete') {
        if (!steerEnqueued) {
          // Mid-turn: queued while the loop is between streaming and executing.
          engine.steer('STOP — change approach');
          steerEnqueued = true;
        } else if (!followUpEnqueued) {
          // Second turn completed streaming; the deciding phase runs next.
          engine.followUp('Now also add tests');
          followUpEnqueued = true;
        }
      }
    }

    // Both queued inputs were consumed.
    expect(steerEnqueued && followUpEnqueued).toBe(true);
    expect(engine.getSteerQueueLength()).toBe(0);
    expect(engine.getFollowUpQueueLength()).toBe(0);

    // The steer was drained at the executing→streaming safe point and surfaced
    // as an agent:steered event BETWEEN turn 1 and turn 2 completions.
    const turnCompleteIdx = events.map((e, i) => (e.type === 'agent:turn_complete' ? i : -1)).filter(i => i >= 0);
    const steeredIdx = events.findIndex(e => e.type === 'agent:steered');
    expect(steeredIdx).toBeGreaterThan(-1);
    expect(events[steeredIdx].message.content).toBe('STOP — change approach');
    expect(turnCompleteIdx.length).toBeGreaterThanOrEqual(2);
    expect(steeredIdx).toBeGreaterThan(turnCompleteIdx[0]);
    expect(steeredIdx).toBeLessThan(turnCompleteIdx[1]);

    // The follow-up started an implicit extra turn: exactly 3 provider calls.
    expect(llm.getCallLog().length).toBe(3);
    const followUpInHistory = engine.getMessages().some(m => m.role === 'user' && m.content === 'Now also add tests');
    expect(followUpInHistory).toBe(true);

    // The query ultimately completed normally.
    expect(events.some(e => e.type === 'agent:complete')).toBe(true);
    expect(engine.getStateMachine().currentState).toBe('completed');
  });
});
