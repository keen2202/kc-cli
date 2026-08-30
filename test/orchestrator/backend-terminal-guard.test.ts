// T26 (M1): both backends share one terminal-event guard — round4 §6-M1
//
// The divergence the audit found: the in-process backend guarded duplicate
// terminal events (FUN-07), the subprocess one did not. These fixtures prove
// the shared guard on the subprocess side: a child that emits `result` twice,
// or emits `result` and then dies, produces exactly ONE terminal event.

import { describe, it, expect, afterAll } from 'vitest';
import { versions } from 'node:process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventBus } from '../../src/orchestrator/event-bus';
import { SubprocessBackend } from '../../src/orchestrator/backends/subprocess';
import { InProcessBackend } from '../../src/orchestrator/backends/in-process';
import { TerminalEventGuard, BaseSubAgentBackend } from '../../src/orchestrator/backends/backend-shared';
import type { SubAgentSpawnConfig } from '../../src/orchestrator/types';
import type { PermissionMode } from '../../src/permissions/protocol';
import type { ToolUseContext } from '../../src/tools/protocol';

const [nodeMajor, nodeMinor] = versions.node.split('.').map((n) => parseInt(n, 10));
const tsWorkersSupported = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 18);

const FIXTURE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-terminal-guard-'));

const REDIRECT_SHIM = path.join(FIXTURE_DIR, 'kc-worker-redirect.cjs');
fs.writeFileSync(
  REDIRECT_SHIM,
  [
    "'use strict';",
    "const Module = require('node:module');",
    'const orig = Module._resolveFilename;',
    'Module._resolveFilename = function (request, ...rest) {',
    "  if (typeof request === 'string' && request.endsWith('subprocess-worker.js')) {",
    '    const target = process.env.KC_TEST_WORKER_TARGET;',
    '    if (target) return target;',
    '  }',
    '  return orig.call(this, request, ...rest);',
    '};',
  ].join('\n'),
);

function writeFixture(name: string, body: string): string {
  const p = path.join(FIXTURE_DIR, name);
  fs.writeFileSync(p, body);
  return p;
}

/** Ready, emits TWO result envelopes, then exits 0. */
const DOUBLE_RESULT_WORKER = writeFixture(
  'double-result-worker.mjs',
  [
    "process.send({ type: 'ready' });",
    "process.on('message', (m) => {",
    "  if (m && m.type === 'init') {",
    "    const mk = () => ({ agentId: process.env.KC_AGENT_ID, name: 'x', success: true, output: 'ok', toolUseCount: 0, totalTokensUsed: 0, duration: 1 });",
    '    process.send({ type: "result", result: mk() });',
    '    setTimeout(() => process.send({ type: "result", result: mk() }), 30);',
    '    setTimeout(() => process.exit(0), 60);',
    '  }',
    '});',
  ].join('\n'),
);

/** Ready, emits a result envelope, then crashes with exit code 3. */
const RESULT_THEN_CRASH_WORKER = writeFixture(
  'result-crash-worker.mjs',
  [
    "process.send({ type: 'ready' });",
    "process.on('message', (m) => {",
    "  if (m && m.type === 'init') {",
    "    process.send({ type: 'result', result: { agentId: process.env.KC_AGENT_ID, name: 'x', success: true, output: 'done', toolUseCount: 0, totalTokensUsed: 0, duration: 1 } });",
    '    setTimeout(() => process.exit(3), 50);',
    '  }',
    '});',
  ].join('\n'),
);

function withWorkerTarget(target: string): () => void {
  const prev = { NODE_OPTIONS: process.env.NODE_OPTIONS, KC_TEST_WORKER_TARGET: process.env.KC_TEST_WORKER_TARGET };
  process.env.NODE_OPTIONS = `--require ${REDIRECT_SHIM}`;
  process.env.KC_TEST_WORKER_TARGET = target;
  return () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

interface CollectedEvent {
  event: Record<string, unknown> & { type?: string };
}

function makeBackend() {
  const bus = new EventBus();
  const backend = new SubprocessBackend(bus, [], 'default' as PermissionMode, FIXTURE_DIR);
  const collected: CollectedEvent[] = [];
  bus.onAny((_agentId, event) => collected.push({ event: event as CollectedEvent['event'] }));
  return { backend, collected };
}

async function spawnWith(backend: SubprocessBackend, name: string) {
  const full: SubAgentSpawnConfig = { name, prompt: 'p', systemPromptMode: 'default' };
  return backend.spawn(full, {} as unknown as ToolUseContext);
}

async function waitFor(
  collected: CollectedEvent[],
  type: string,
  ms: number,
): Promise<CollectedEvent | null> {
  const deadline = Date.now() + ms;
  for (;;) {
    const hit = collected.find((e) => e.event.type === type);
    if (hit) return hit;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 50));
  }
}

afterAll(() => {
  fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

describe('T26: subprocess terminal events are emitted at most once', () => {
  it('suppresses a duplicate result envelope from the child', async () => {
    const { backend, collected } = makeBackend();
    const restore = withWorkerTarget(DOUBLE_RESULT_WORKER);
    try {
      const spawn = await spawnWith(backend, 'dup');
      expect(spawn.success).toBe(true);

      await waitFor(collected, 'agent:subagent_completed', 8000);
      await new Promise((r) => setTimeout(r, 300)); // let the duplicate + exit land
      const terminal = collected.filter((e) =>
        ['agent:subagent_completed', 'agent:subagent_failed', 'agent:subagent_cancelled', 'agent:subagent_timed_out'].includes(e.event.type as string),
      );
      expect(terminal.length).toBe(1);
    } finally {
      restore();
      await backend.shutdownAll();
    }
  }, 20000);

  it('suppresses the exit-path terminal after a child-authored result', async () => {
    const { backend, collected } = makeBackend();
    const restore = withWorkerTarget(RESULT_THEN_CRASH_WORKER);
    try {
      const spawn = await spawnWith(backend, 'crash');
      expect(spawn.success).toBe(true);

      await waitFor(collected, 'agent:subagent_completed', 8000);
      await new Promise((r) => setTimeout(r, 400)); // let the exit(3) path land
      const terminal = collected.filter((e) =>
        ['agent:subagent_completed', 'agent:subagent_failed', 'agent:subagent_cancelled', 'agent:subagent_timed_out'].includes(e.event.type as string),
      );
      // Previously: result → completed, then exit(3) → a SECOND completed event.
      expect(terminal.length).toBe(1);
    } finally {
      restore();
      await backend.shutdownAll();
    }
  }, 20000);
});

describe('T26: shared status semantics across backends', () => {
  it('both backends report null for unknown agents and share one guard class', () => {
    const bus = new EventBus();
    const inProc = new InProcessBackend(bus, [], 'default' as PermissionMode, FIXTURE_DIR);
    const subProc = new SubprocessBackend(bus, [], 'default' as PermissionMode, FIXTURE_DIR);

    expect(inProc.getStatus('nobody@0')).toBeNull();
    expect(subProc.getStatus('nobody@0')).toBeNull();
    expect(inProc.listActive()).toEqual([]);
    expect(subProc.listActive()).toEqual([]);
    // One guard implementation protects both: both classes extend the shared base.
    expect(Object.getPrototypeOf(InProcessBackend.prototype)).toBe(BaseSubAgentBackend.prototype);
    expect(Object.getPrototypeOf(SubprocessBackend.prototype)).toBe(BaseSubAgentBackend.prototype);
    const guard = new TerminalEventGuard();
    expect(guard.hasSent('a')).toBe(false);
  });

  it.skipIf(!tsWorkersSupported)(
    'TerminalEventGuard emits once and ignores repeats (unit)',
    () => {
      const bus = new EventBus();
      const seen: string[] = [];
      bus.onAny((_id, e) => seen.push((e as { type?: string }).type ?? '?'));
      const guard = new TerminalEventGuard();

      const mk = (type: string) => ({ type } as never);
      expect(guard.emitOnce('a1', bus, mk('agent:subagent_completed'))).toBe(true);
      expect(guard.emitOnce('a1', bus, mk('agent:subagent_failed'))).toBe(false);
      expect(guard.emitOnce('a1', bus, mk('agent:subagent_completed'))).toBe(false);
      expect(guard.emitOnce('a2', bus, mk('agent:subagent_completed'))).toBe(true);
      expect(seen).toEqual(['agent:subagent_completed', 'agent:subagent_completed']);
    },
  );
});
