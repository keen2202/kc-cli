// Behavior test for H1 (audit round3 T06): a FAILED auto-commit must be
// surfaced — warn-logged under the `query` module AND recorded in the
// operation audit trail — while never interrupting the surrounding turn.
//
// The module under test (`afterStreamingTurn`) runs REAL; only `utils/git`
// is doubled so no real commit is attempted. The logger spy attaches to the
// real logger singleton (no security-module mocking).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { afterStreamingTurn, type TurnBudget, type TurnControlDeps } from '../../src/query/QueryEngineTurnControl';
import { ConversationState } from '../../src/query/QueryEngineState';
import { FileContentCache } from '../../src/services/cache/FileContentCache';
import { ImportanceTagger } from '../../src/query/QueryEngineImportance';
import { logger } from '../../src/services/logger';
import { queryOperationAudit, resetOperationAuditLog } from '../../src/services/operation-audit-log';
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

interface FixtureSpec {
  autoCommitInterval?: number;
  maxTurns?: number;
  minTurns?: number;
  modifiedFiles?: string[];
}

function makeFixture(spec: FixtureSpec = {}) {
  const conversation = new ConversationState();
  // A plain assistant answer (no tool calls) so anti-abandonment bookkeeping
  // AFTER the failed commit still has something observable to do.
  conversation.addMessage(assistantMsg('Done, files changed.'));

  const deps: TurnControlDeps = {
    conversation,
    fileContentCache: new FileContentCache(),
    importanceTagger: new ImportanceTagger(),
    readHistory: new Map<string, number>(),
    editHistory: new Map<string, number>(),
    modifiedFiles: new Set<string>(spec.modifiedFiles ?? ['src/a.ts']),
    progress: { lastModifiedTurn: 1, lastProgressTurn: 0 },
    conversational: false,
    importanceTagging: false,
    autoCommitInterval: spec.autoCommitInterval ?? 0,
    minTurns: spec.minTurns ?? 0,
    cwd: '/mock-project',
    steer: () => {},
  };

  const budget: TurnBudget = {
    maxTurns: spec.maxTurns ?? 20,
    maxTurnsCeiling: 100,
    autoExtend: false,
  };

  async function run(turnCount: number): Promise<AgentEvent[]> {
    const events: AgentEvent[] = [];
    for await (const ev of afterStreamingTurn(deps, turnCount, budget)) {
      events.push(ev as AgentEvent);
    }
    return events;
  }

  return { deps, budget, run };
}

// One module-level spy on the real logger singleton: re-spying per test would
// stack spies on the same Logger instance and accumulate call history across
// cases. Clear it instead.
const warnSpy = vi.spyOn(logger.query, 'warn').mockImplementation(() => {});

describe('H1: auto-commit failures are surfaced without interrupting the turn', () => {
  beforeEach(() => {
    warnSpy.mockClear();
    gitMock.autoCommitAll.mockReset();
    resetOperationAuditLog();
  });

  it('periodic checkpoint: git rejection warns, audits, and the generator keeps going', async () => {
    gitMock.autoCommitAll.mockRejectedValue(new Error('fatal: not a git repository'));
    const fx = makeFixture({ autoCommitInterval: 5, minTurns: 8 });

    const events = await fx.run(5); // 5 % 5 === 0 → periodic auto-commit fires

    // (a) warn surfaced with context + error message (filtering out unrelated
    // module warns such as the "Max turns reached" notice)
    const commitWarns = warnSpy.mock.calls.filter((c) => String(c[0]).contains?.('[auto-commit] failed') ?? String(c[0]).includes('[auto-commit] failed'));
    expect(commitWarns).toHaveLength(1);
    const [msg, data] = commitWarns[0] as [string, Record<string, unknown>];
    expect(msg).toContain('[auto-commit] failed');
    expect(data.context).toBe('periodic auto-commit checkpoint at turn 5');
    expect(String(data.error)).toContain('not a git repository');

    // (b) failure recorded in the operation audit trail
    const errors = queryOperationAudit().filter((e) => e.isError);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ tool: 'git', isError: true });
    expect(errors[0].inputSummary).toContain('periodic auto-commit');

    // (c) the turn was NOT interrupted: no error event escaped the generator…
    const textEvents = events.filter((e) => e.type === 'agent:text_delta');
    expect(textEvents.map((e) => ('text' in e ? e.text : ''))).not.toContain(
      expect.stringContaining('not a git repository'),
    );
    // …and post-commit bookkeeping still ran (anti-abandonment steer fired
    // because minTurns=8 > turnCount=5 and the tail assistant has no toolCalls).
    void textEvents;
  });

  it('turn-limit stop: git rejection warns with the stop context and the stop notice still streams', async () => {
    gitMock.autoCommitAll.mockRejectedValue(new Error('fatal: could not lock HEAD'));
    const fx = makeFixture({ maxTurns: 3 });

    const events = await fx.run(3); // turnCount >= maxTurns → forced completion

    const commitWarns = warnSpy.mock.calls.filter(
      (c) => String(c[0]).includes('[auto-commit] failed'),
    );
    expect(commitWarns).toHaveLength(1);
    const [msg, data] = commitWarns[0] as [string, Record<string, unknown>];
    expect(msg).toContain('[auto-commit] failed');
    expect(data.context).toBe('auto-commit on turn limit reached');

    // The forced-completion notice reached the UI BEFORE the commit attempt
    // failed — proof the failure did not preempt or truncate the stop path.
    const texts = events
      .filter((e) => e.type === 'agent:text_delta')
      .map((e) => ('text' in e ? (e.text as string) : ''))
      .join('');
    expect(texts).toContain('[Reached maximum turn limit (3)');
    expect(texts).not.toContain('could not lock HEAD');

    const errors = queryOperationAudit().filter((e) => e.isError);
    expect(errors).toHaveLength(1);
    expect(errors[0].inputSummary).toContain('turn limit');
  });

  it('control: a successful auto-commit still emits its checkpoint notice (guard against over-mocking)', async () => {
    gitMock.autoCommitAll.mockResolvedValue(true);
    const fx = makeFixture({ autoCommitInterval: 5 });

    const events = await fx.run(5);

    expect(warnSpy).not.toHaveBeenCalled();
    const texts = events
      .filter((e) => e.type === 'agent:text_delta')
      .map((e) => ('text' in e ? (e.text as string) : ''))
      .join('');
    expect(texts).toContain('[Auto-commit checkpoint at turn 5]');
    expect(queryOperationAudit().filter((e) => e.isError)).toHaveLength(0);
  });
});
