// Behavior tests for the QueryEngine Decision submodule (audit round3 T13 / H6).
//
// Scope: `src/query/QueryEngineDecision.ts` (DecisionGates) — the 'deciding'
// exit-gate state logic: continue-vs-end-turn, tool-call follow-up decisions,
// anti-abandonment, forced git commit on exit, zero-patch retry budget (B1),
// pre-exit type-check (B3) and test verification (B2) budgets, and the T7
// gate-report capture consumed by the completion report.
//
// The module under test is driven REAL (`new DecisionGates()` + a plain
// DecisionContext). Only process-spawning dependencies are mocked:
//   - `utils/git.autoCommitAll` (no real git calls),
//   - the two verification command runners in QueryEngineVerification
//     (they spawn child processes; the pure helpers — including
//     extractFailToPassTests — stay REAL via importOriginal).
// No network, no git, fully deterministic.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DecisionGates, type DecisionContext } from '../../src/query/QueryEngineDecision';
import type { AssistantMessage, ChatMessage, PatchGuaranteeConfig, UserMessage } from '../../src/query/protocol';
import { initializeState } from '../../src/bootstrap/state';

// ── Hoisted mocks ──

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

const verificationMock = vi.hoisted(() => ({
  verifyTypeCheckBeforeExit: vi.fn(),
  verifyBeforeExit: vi.fn(),
}));

vi.mock('../../src/query/QueryEngineVerification', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/query/QueryEngineVerification')>();
  return {
    ...actual,
    // Only the child_process-spawning runners are replaced; the pure helpers
    // (extractFailToPassTests, isTestCommandSafe, gate-report mappers) stay real.
    verifyTypeCheckBeforeExit: verificationMock.verifyTypeCheckBeforeExit,
    verifyBeforeExit: verificationMock.verifyBeforeExit,
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

function userMsg(content: string): UserMessage {
  return {
    id: `user_${++msgCounter}`,
    role: 'user',
    content,
    timestamp: Date.now(),
  };
}

function toolCall(id: string, toolName = 'Bash'): NonNullable<AssistantMessage['toolCalls']>[number] {
  return { id, toolName, input: { command: 'echo hi' }, status: 'completed' };
}

function pgConfig(overrides: Partial<PatchGuaranteeConfig> = {}): PatchGuaranteeConfig {
  return {
    enabled: true,
    maxZeroPatchRetries: 3,
    maxVerificationRetries: 2,
    verificationTimeout: 60,
    testCommand: 'pytest {test_names} -x',
    typeCheck: true,
    typeCheckCommand: 'npx tsc --noEmit',
    maxTypeCheckRetries: 2,
    ...overrides,
  };
}

interface CtxSpec {
  turnCount?: number;
  minTurns?: number;
  conversational?: boolean;
  modifiedFilesCount?: number;
  patchGuarantee?: PatchGuaranteeConfig;
  messages?: ChatMessage[];
}

function makeCtx(spec: CtxSpec = {}): { ctx: DecisionContext; steers: string[]; addedMessages: ChatMessage[] } {
  const steers: string[] = [];
  const addedMessages: ChatMessage[] = [];
  const messages = spec.messages ?? [];
  const ctx: DecisionContext = {
    turnCount: spec.turnCount ?? 5,
    minTurns: spec.minTurns ?? 0,
    conversational: spec.conversational ?? false,
    cwd: '/mock-project',
    modifiedFilesCount: spec.modifiedFilesCount ?? 0,
    patchGuarantee: spec.patchGuarantee,
    getLastMessage: () => messages[messages.length - 1],
    getMessages: () => messages,
    steer: (m) => { steers.push(m); },
    addMessage: (m) => { addedMessages.push(m); },
  };
  return { ctx, steers, addedMessages };
}

// ── Tests ──

describe('DecisionGates — continue vs end turn', () => {
  beforeEach(() => {
    initializeState({ cwd: '/mock-project' });
    vi.clearAllMocks();
    gitMock.autoCommitAll.mockResolvedValue(true);
  });

  it('forces continuation below minTurns when the conversation has no assistant tail', async () => {
    const gates = new DecisionGates();
    const { ctx } = makeCtx({ turnCount: 1, minTurns: 3, messages: [userMsg('do the task')] });
    await expect(gates.decide(ctx)).resolves.toBe(true);
  });

  it('ends the turn when there is no assistant tail and minTurns is satisfied', async () => {
    const gates = new DecisionGates();
    const { ctx } = makeCtx({ turnCount: 3, minTurns: 3, messages: [userMsg('do the task')] });
    await expect(gates.decide(ctx)).resolves.toBe(false);
  });

  it('exempts conversational queries from the minTurns force-continuation', async () => {
    const gates = new DecisionGates();
    const { ctx } = makeCtx({ turnCount: 0, minTurns: 3, conversational: true, messages: [] });
    await expect(gates.decide(ctx)).resolves.toBe(false);
  });

  it('continues when the assistant issued tool calls (follow-up decision)', async () => {
    const gates = new DecisionGates();
    const { ctx } = makeCtx({
      turnCount: 5,
      messages: [userMsg('run the tests'), assistantMsg('running', [toolCall('c1')])],
      patchGuarantee: pgConfig({ enabled: false }),
    });
    await expect(gates.decide(ctx)).resolves.toBe(true);
  });

  it('treats an empty toolCalls array as no tool calls', async () => {
    const gates = new DecisionGates();
    const { ctx } = makeCtx({
      turnCount: 5,
      messages: [assistantMsg('nothing to do', [])],
      patchGuarantee: pgConfig({ enabled: false }),
    });
    await expect(gates.decide(ctx)).resolves.toBe(false);
  });

  it('continues for tool calls even on conversational queries', async () => {
    const gates = new DecisionGates();
    const { ctx } = makeCtx({
      turnCount: 1,
      conversational: true,
      messages: [assistantMsg('let me check', [toolCall('c1')])],
      patchGuarantee: pgConfig({ enabled: false }),
    });
    await expect(gates.decide(ctx)).resolves.toBe(true);
  });

  it('ends cleanly when the assistant answered without tools and gates are disabled', async () => {
    const gates = new DecisionGates();
    const { ctx } = makeCtx({
      turnCount: 5,
      messages: [assistantMsg('all done')],
      patchGuarantee: pgConfig({ enabled: false }),
    });
    await expect(gates.decide(ctx)).resolves.toBe(false);
  });
});

describe('DecisionGates — anti-abandonment and forced commit ordering', () => {
  beforeEach(() => {
    initializeState({ cwd: '/mock-project' });
    vi.clearAllMocks();
    gitMock.autoCommitAll.mockResolvedValue(true);
  });

  it('forces continuation below minTurns before any commit or steer fires', async () => {
    const gates = new DecisionGates();
    const { ctx, steers } = makeCtx({
      turnCount: 1,
      minTurns: 3,
      modifiedFilesCount: 2,
      messages: [assistantMsg('I think I am done')],
      patchGuarantee: pgConfig({ enabled: false }),
    });
    await expect(gates.decide(ctx)).resolves.toBe(true);
    expect(steers).toHaveLength(0);
    expect(gitMock.autoCommitAll).not.toHaveBeenCalled();
  });

  it('at exactly minTurns the anti-abandonment gate releases and the exit path runs', async () => {
    const gates = new DecisionGates();
    const { ctx } = makeCtx({
      turnCount: 3,
      minTurns: 3,
      modifiedFilesCount: 1,
      messages: [assistantMsg('done')],
      patchGuarantee: pgConfig({ enabled: false }),
    });
    await expect(gates.decide(ctx)).resolves.toBe(false);
    expect(gitMock.autoCommitAll).toHaveBeenCalledTimes(1);
  });
});

describe('DecisionGates — forced git commit on exit (P0)', () => {
  beforeEach(() => {
    initializeState({ cwd: '/mock-project' });
    vi.clearAllMocks();
  });

  it('commits once with the engine cwd when exiting with uncommitted changes', async () => {
    gitMock.autoCommitAll.mockResolvedValue(true);
    const gates = new DecisionGates();
    const { ctx } = makeCtx({
      turnCount: 5,
      modifiedFilesCount: 2,
      messages: [assistantMsg('done')],
      patchGuarantee: pgConfig({ enabled: false }),
    });
    await expect(gates.decide(ctx)).resolves.toBe(false);
    expect(gitMock.autoCommitAll).toHaveBeenCalledTimes(1);
    expect(gitMock.autoCommitAll).toHaveBeenCalledWith('/mock-project');
  });

  it('does not commit when the assistant still has pending tool calls', async () => {
    gitMock.autoCommitAll.mockResolvedValue(true);
    const gates = new DecisionGates();
    const { ctx } = makeCtx({
      turnCount: 5,
      modifiedFilesCount: 3,
      messages: [assistantMsg('continuing', [toolCall('c1')])],
      patchGuarantee: pgConfig({ enabled: false }),
    });
    await expect(gates.decide(ctx)).resolves.toBe(true);
    expect(gitMock.autoCommitAll).not.toHaveBeenCalled();
  });

  it('continues normally when there is nothing to commit (autoCommitAll resolves false)', async () => {
    gitMock.autoCommitAll.mockResolvedValue(false);
    const gates = new DecisionGates();
    const { ctx } = makeCtx({
      turnCount: 5,
      modifiedFilesCount: 1,
      messages: [assistantMsg('done')],
      patchGuarantee: pgConfig({ enabled: false }),
    });
    await expect(gates.decide(ctx)).resolves.toBe(false);
  });

  it('swallows a git failure — the exit decision is not interrupted (non-fatal)', async () => {
    gitMock.autoCommitAll.mockRejectedValue(new Error('git: not a repository'));
    const gates = new DecisionGates();
    const { ctx } = makeCtx({
      turnCount: 5,
      modifiedFilesCount: 1,
      messages: [assistantMsg('done')],
      patchGuarantee: pgConfig({ enabled: false }),
    });
    await expect(gates.decide(ctx)).resolves.toBe(false);
  });

  it('skips the forced commit entirely for conversational exits', async () => {
    gitMock.autoCommitAll.mockResolvedValue(true);
    const gates = new DecisionGates();
    const { ctx } = makeCtx({
      turnCount: 2,
      conversational: true,
      modifiedFilesCount: 4,
      messages: [assistantMsg('here is your answer')],
      patchGuarantee: pgConfig({ enabled: true }),
    });
    await expect(gates.decide(ctx)).resolves.toBe(false);
    expect(gitMock.autoCommitAll).not.toHaveBeenCalled();
  });
});

describe('DecisionGates — zero-patch detection (B1)', () => {
  beforeEach(() => {
    initializeState({ cwd: '/mock-project' });
    vi.clearAllMocks();
    gitMock.autoCommitAll.mockResolvedValue(true);
  });

  it('steers PATCH REQUIRED and forces continuation on the first zero-patch exit', async () => {
    const gates = new DecisionGates();
    const { ctx, steers } = makeCtx({
      turnCount: 5,
      messages: [assistantMsg('I looked at the code')],
      patchGuarantee: pgConfig({ maxZeroPatchRetries: 3 }),
    });
    await expect(gates.decide(ctx)).resolves.toBe(true);
    expect(gates.zeroPatchRetries).toBe(1);
    expect(steers).toHaveLength(1);
    expect(steers[0]).toContain('PATCH REQUIRED');
    expect(steers[0]).toContain('Retry 1/3');
  });

  it('exhausts the zero-patch budget and then lets the query end without further steers', async () => {
    const gates = new DecisionGates();
    const { ctx, steers } = makeCtx({
      turnCount: 5,
      messages: [assistantMsg('nothing changed')],
      patchGuarantee: pgConfig({ maxZeroPatchRetries: 2 }),
    });

    await expect(gates.decide(ctx)).resolves.toBe(true);  // retry 1/2
    await expect(gates.decide(ctx)).resolves.toBe(true);  // retry 2/2
    expect(steers).toHaveLength(2);

    // Budget exhausted → exit allowed, and no third steer is emitted.
    await expect(gates.decide(ctx)).resolves.toBe(false);
    expect(steers).toHaveLength(2);
    expect(gates.zeroPatchRetries).toBe(2);
  });

  it('honors a custom maxZeroPatchRetries budget boundary', async () => {
    const gates = new DecisionGates();
    const { ctx } = makeCtx({
      turnCount: 5,
      messages: [assistantMsg('answer without edits')],
      patchGuarantee: pgConfig({ maxZeroPatchRetries: 1 }),
    });
    await expect(gates.decide(ctx)).resolves.toBe(true);
    await expect(gates.decide(ctx)).resolves.toBe(false);
  });

  it('does not apply zero-patch steering when the agent modified files', async () => {
    const gates = new DecisionGates();
    const { ctx, steers } = makeCtx({
      turnCount: 5,
      modifiedFilesCount: 1,
      messages: [assistantMsg('patched and verified')],
      patchGuarantee: pgConfig({ typeCheck: false }),
    });
    await expect(gates.decide(ctx)).resolves.toBe(false);
    expect(steers).toHaveLength(0);
    expect(gates.zeroPatchRetries).toBe(0);
  });

  it('skips zero-patch steering when patchGuarantee is disabled', async () => {
    const gates = new DecisionGates();
    const { ctx, steers } = makeCtx({
      turnCount: 5,
      messages: [assistantMsg('answer')],
      patchGuarantee: pgConfig({ enabled: false }),
    });
    await expect(gates.decide(ctx)).resolves.toBe(false);
    expect(steers).toHaveLength(0);
    expect(gates.zeroPatchRetries).toBe(0);
  });

  it('reset() restores a fresh zero-patch budget for the next query', async () => {
    const gates = new DecisionGates();
    const spec = {
      turnCount: 5,
      messages: [assistantMsg('answer')],
      patchGuarantee: pgConfig({ maxZeroPatchRetries: 1 }),
    };
    const first = makeCtx(spec);
    await expect(gates.decide(first.ctx)).resolves.toBe(true);
    await expect(gates.decide(first.ctx)).resolves.toBe(false); // exhausted

    gates.reset();
    expect(gates.zeroPatchRetries).toBe(0);

    const second = makeCtx(spec);
    await expect(gates.decide(second.ctx)).resolves.toBe(true); // fresh budget
    expect(second.steers).toHaveLength(1);
  });
});

describe('DecisionGates — pre-exit type-check gate (B3)', () => {
  beforeEach(() => {
    initializeState({ cwd: '/mock-project' });
    vi.clearAllMocks();
    gitMock.autoCommitAll.mockResolvedValue(true);
    verificationMock.verifyTypeCheckBeforeExit.mockResolvedValue({ canExit: true, reason: 'typecheck_pass' });
    verificationMock.verifyBeforeExit.mockResolvedValue({ canExit: true, reason: 'tests_pass', output: '' });
  });

  it('steers TYPE-CHECK FAILED, appends a user message, and forces continuation', async () => {
    verificationMock.verifyTypeCheckBeforeExit.mockResolvedValue({
      canExit: false,
      reason: 'typecheck_fail',
      failures: 'src/a.ts(3,7): error TS2322',
    });
    const gates = new DecisionGates();
    const { ctx, steers, addedMessages } = makeCtx({
      turnCount: 5,
      modifiedFilesCount: 2,
      messages: [assistantMsg('done editing')],
      patchGuarantee: pgConfig({}),
    });
    await expect(gates.decide(ctx)).resolves.toBe(true);
    expect(steers).toHaveLength(1);
    expect(steers[0]).toContain('TYPE-CHECK FAILED');
    expect(steers[0]).toContain('(1/2)');
    expect(steers[0]).toContain('error TS2322');
    expect(addedMessages).toHaveLength(1);
    expect(addedMessages[0].role).toBe('user');
    // T7 (M2): the failing gate outcome is captured for the completion report.
    expect(gates.lastTypeCheckGate).toEqual({ ran: true, command: 'npx tsc --noEmit', result: 'fail', details: 'src/a.ts(3,7): error TS2322' });
  });

  it('exhausts the type-check retry budget and then allows exit without re-running', async () => {
    verificationMock.verifyTypeCheckBeforeExit.mockResolvedValue({
      canExit: false,
      reason: 'typecheck_fail',
      failures: 'error TS1',
    });
    const gates = new DecisionGates();
    const spec: CtxSpec = {
      turnCount: 5,
      modifiedFilesCount: 1,
      messages: [assistantMsg('done')],
      patchGuarantee: pgConfig({ maxTypeCheckRetries: 1 }),
    };
    const first = makeCtx(spec);
    await expect(gates.decide(first.ctx)).resolves.toBe(true);

    const second = makeCtx(spec);
    await expect(gates.decide(second.ctx)).resolves.toBe(false);
    // Budget spent: the verifier ran exactly once across both decide() calls.
    expect(verificationMock.verifyTypeCheckBeforeExit).toHaveBeenCalledTimes(1);
  });

  it('blocks exit on a type-check infrastructure error in strict mode', async () => {
    verificationMock.verifyTypeCheckBeforeExit.mockResolvedValue({
      canExit: false,
      reason: 'typecheck_infra_error',
      failures: 'Type-check could not be executed: spawn ENOENT',
    });
    const gates = new DecisionGates();
    const { ctx, steers } = makeCtx({
      turnCount: 5,
      modifiedFilesCount: 1,
      messages: [assistantMsg('done')],
      patchGuarantee: pgConfig({ typeCheckStrict: true }),
    });
    await expect(gates.decide(ctx)).resolves.toBe(true);
    expect(steers[0]).toContain('TYPE-CHECK COULD NOT RUN');
    expect(gates.lastTypeCheckGate?.result).toBe('infra_error');
    expect(gates.lastTypeCheckGate?.ran).toBe(false);
  });

  it('allows exit when the type check passes', async () => {
    const gates = new DecisionGates();
    const { ctx, steers } = makeCtx({
      turnCount: 5,
      modifiedFilesCount: 1,
      messages: [assistantMsg('done')],
      patchGuarantee: pgConfig({}),
    });
    await expect(gates.decide(ctx)).resolves.toBe(false);
    expect(steers).toHaveLength(0);
    expect(gates.lastTypeCheckGate).toEqual({ ran: true, command: 'npx tsc --noEmit', result: 'pass' });
  });

  it('does not run the type check when disabled or when tool calls are pending', async () => {
    const gates = new DecisionGates();
    const disabled = makeCtx({
      turnCount: 5,
      modifiedFilesCount: 1,
      messages: [assistantMsg('done')],
      patchGuarantee: pgConfig({ typeCheck: false }),
    });
    await expect(gates.decide(disabled.ctx)).resolves.toBe(false);
    expect(verificationMock.verifyTypeCheckBeforeExit).not.toHaveBeenCalled();

    const withTools = makeCtx({
      turnCount: 5,
      modifiedFilesCount: 1,
      messages: [assistantMsg('still working', [toolCall('c1')])],
      patchGuarantee: pgConfig({}),
    });
    await expect(gates.decide(withTools.ctx)).resolves.toBe(true);
    expect(verificationMock.verifyTypeCheckBeforeExit).not.toHaveBeenCalled();
  });
});

describe('DecisionGates — pre-exit test verification gate (B2)', () => {
  beforeEach(() => {
    initializeState({ cwd: '/mock-project' });
    vi.clearAllMocks();
    gitMock.autoCommitAll.mockResolvedValue(true);
    verificationMock.verifyTypeCheckBeforeExit.mockResolvedValue({ canExit: true, reason: 'typecheck_pass' });
    verificationMock.verifyBeforeExit.mockResolvedValue({ canExit: true, reason: 'tests_pass', output: '' });
  });

  it('extracts FAIL_TO_PASS names from the conversation (real extractor) and steers on failure', async () => {
    verificationMock.verifyBeforeExit.mockResolvedValue({
      canExit: false,
      reason: 'tests_fail',
      failures: ['FAILED tests/test_a.py::test_one'],
    });
    const gates = new DecisionGates();
    const { ctx, steers, addedMessages } = makeCtx({
      turnCount: 5,
      modifiedFilesCount: 1,
      messages: [
        userMsg('FAIL_TO_PASS: tests/test_a.py::test_one, tests/test_b.py::test_two'),
        assistantMsg('fixed the bug'),
      ],
      patchGuarantee: pgConfig({ typeCheck: false }),
    });
    await expect(gates.decide(ctx)).resolves.toBe(true);
    expect(verificationMock.verifyBeforeExit).toHaveBeenCalledWith(
      ['tests/test_a.py::test_one', 'tests/test_b.py::test_two'],
      expect.objectContaining({ testCommand: 'pytest {test_names} -x' })
    );
    expect(steers).toHaveLength(1);
    expect(steers[0]).toContain('VERIFICATION FAILED');
    expect(steers[0]).toContain('(1/2)');
    expect(addedMessages[0].role).toBe('user');
    expect(gates.lastTestGate).toEqual({
      ran: true,
      command: 'pytest {test_names} -x',
      result: 'fail',
      details: 'FAILED tests/test_a.py::test_one',
    });
  });

  it('exhausts the verification retry budget and then allows exit', async () => {
    verificationMock.verifyBeforeExit.mockResolvedValue({
      canExit: false,
      reason: 'tests_fail',
      failures: ['FAILED x'],
    });
    const gates = new DecisionGates();
    const spec: CtxSpec = {
      turnCount: 5,
      modifiedFilesCount: 1,
      messages: [userMsg('FAIL_TO_PASS: tests/test_a.py::test_one'), assistantMsg('fix')],
      patchGuarantee: pgConfig({ typeCheck: false, maxVerificationRetries: 1 }),
    };
    const first = makeCtx(spec);
    await expect(gates.decide(first.ctx)).resolves.toBe(true);

    const second = makeCtx(spec);
    await expect(gates.decide(second.ctx)).resolves.toBe(false);
    expect(verificationMock.verifyBeforeExit).toHaveBeenCalledTimes(1);
    expect(second.steers).toHaveLength(0);
  });

  it('allows exit when the tests pass and records a passing gate report', async () => {
    const gates = new DecisionGates();
    const { ctx, steers } = makeCtx({
      turnCount: 5,
      modifiedFilesCount: 1,
      messages: [userMsg('FAIL_TO_PASS: tests/test_a.py::test_one'), assistantMsg('fix')],
      patchGuarantee: pgConfig({ typeCheck: false }),
    });
    await expect(gates.decide(ctx)).resolves.toBe(false);
    expect(steers).toHaveLength(0);
    expect(gates.lastTestGate).toEqual({
      ran: true,
      command: 'pytest {test_names} -x',
      result: 'pass',
    });
  });

  it('skips test verification when no FAIL_TO_PASS tests exist', async () => {
    const gates = new DecisionGates();
    const { ctx } = makeCtx({
      turnCount: 5,
      modifiedFilesCount: 1,
      messages: [assistantMsg('no tests referenced')],
      patchGuarantee: pgConfig({ typeCheck: false }),
    });
    await expect(gates.decide(ctx)).resolves.toBe(false);
    expect(verificationMock.verifyBeforeExit).not.toHaveBeenCalled();
  });
});

describe('DecisionGates — gate report lifecycle (T7/M2)', () => {
  beforeEach(() => {
    initializeState({ cwd: '/mock-project' });
    vi.clearAllMocks();
    gitMock.autoCommitAll.mockResolvedValue(true);
  });

  it('reset() clears the captured gate reports and all retry budgets', async () => {
    // Type check passes (so decide() proceeds to the B2 test gate), tests fail.
    verificationMock.verifyTypeCheckBeforeExit.mockResolvedValue({
      canExit: true, reason: 'typecheck_pass',
    });
    verificationMock.verifyBeforeExit.mockResolvedValue({
      canExit: false, reason: 'tests_fail', failures: ['FAILED x'],
    });
    const gates = new DecisionGates();
    const { ctx } = makeCtx({
      turnCount: 5,
      modifiedFilesCount: 1,
      messages: [userMsg('FAIL_TO_PASS: tests/test_a.py::test_one'), assistantMsg('fix')],
      patchGuarantee: pgConfig({}),
    });
    await expect(gates.decide(ctx)).resolves.toBe(true);
    expect(gates.lastTypeCheckGate).not.toBeNull();
    expect(gates.lastTestGate).not.toBeNull();
    expect(gates.zeroPatchRetries).toBe(0); // files were modified — B1 untouched

    gates.reset();
    expect(gates.lastTypeCheckGate).toBeNull();
    expect(gates.lastTestGate).toBeNull();
    expect(gates.zeroPatchRetries).toBe(0);
  });
});
