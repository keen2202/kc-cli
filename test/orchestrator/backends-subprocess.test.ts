import { describe, it, expect, vi, afterAll } from 'vitest';
import { versions } from 'node:process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventBus } from '../../src/orchestrator/event-bus';
import { SubprocessBackend } from '../../src/orchestrator/backends/subprocess';
import { logger } from '../../src/services/logger';
import { deriveChildPermissions } from '../../src/orchestrator/permission-cascader';
import type { SubAgentSpawnConfig } from '../../src/orchestrator/types';
import type { PermissionMode } from '../../src/permissions/protocol';
import type { ToolUseContext } from '../../src/tools/protocol';

/**
 * Behavior tests for the orchestrator subprocess backend (T14 / round3-H7).
 *
 * Everything below drives REAL child processes:
 * - the REAL `subprocess-worker.ts` script executed by plain `node`
 *   (Node >= 22.18 strips types natively), reached through the backend's own
 *   `fork()` call via an env-injected resolution shim, and
 * - small `.mjs` fixture workers (written to a temp dir at module load) where
 *   a scenario needs controllable timing (hang / crash / result emission).
 *   Fixtures implement the documented parent<->worker IPC protocol
 *   ({ready|event|result|error} / {init|message|shutdown}); the production
 *   worker itself is never mocked.
 *
 * The shim exists because SubprocessBackend forks
 * `path.resolve(__dirname, 'subprocess-worker.js')`, a file that does not
 * exist in an unbuilt tree. We inject `NODE_OPTIONS=--require redirect.cjs`
 * through the backend's documented env passthrough; the preload maps that one
 * specifier onto a test target (default: the real TS worker) before Node's
 * entry resolution runs. Env is restored immediately after each spawn.
 */

// Node executes .ts files directly (type stripping unflagged) from 22.18.
const [nodeMajor, nodeMinor] = versions.node.split('.').map((n) => parseInt(n, 10));
const tsWorkersSupported = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 18);

const FIXTURE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-subprocess-backend-'));

/** CJS preload: redirect the backend's compiled-worker specifier to a target. */
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

/** Ignores everything, never becomes ready — exercises the 5s ready fallback. */
const SILENT_WORKER = writeFixture('silent-worker.mjs', 'setInterval(() => {}, 1 << 30);\n');

/** Ready, then hangs forever — exercised for timeout abort / force kill. */
const HANG_WORKER = writeFixture(
  'hang-worker.mjs',
  [
    "process.send({ type: 'ready' });",
    'setInterval(() => {}, 1 << 30);',
    "process.on('message', () => {});",
  ].join('\n'),
);

/**
 * Ready, echoes the init config name into a text_delta event, exits 0 only on
 * shutdown — exercised for graceful shutdown and bidirectional IPC.
 */
const GRACEFUL_WORKER = writeFixture(
  'graceful-worker.mjs',
  [
    "let name = 'unknown';",
    "process.send({ type: 'ready' });",
    "process.on('message', (m) => {",
    "  if (m && m.type === 'init') { name = (m.config && m.config.name) || 'unknown'; }",
    "  if (m && m.type === 'shutdown') {",
    "    process.send({ type: 'event', event: { type: 'agent:text_delta', text: 'bye:' + name, timestamp: 9 } });",
    '    setTimeout(() => process.exit(0), 50);',
    '  }',
    '});',
  ].join('\n'),
);

/** Ready, emits counting events on init, then crashes with exit code 3. */
const CRASH_WORKER = writeFixture(
  'crash-worker.mjs',
  [
    "process.send({ type: 'ready' });",
    "process.on('message', (m) => {",
    "  if (m && m.type === 'init') {",
    "    process.send({ type: 'event', event: { type: 'agent:text_delta', text: 'a', timestamp: 1 } });",
    "    process.send({ type: 'event', event: { type: 'agent:tool_completed', toolCall: { name: 'Bash' }, result: { metadata: { tokensUsed: 42 } }, timestamp: 2 } });",
    '    setTimeout(() => process.exit(3), 50);',
    '  }',
    '});',
  ].join('\n'),
);

/**
 * Ready, echoes the init config name inside a proper result envelope — proves
 * child-authored results are propagated verbatim to the event bus.
 */
const RESULT_WORKER = writeFixture(
  'result-worker.mjs',
  [
    "process.send({ type: 'ready' });",
    "process.on('message', (m) => {",
    "  if (m && m.type === 'init') {",
    "    const name = (m.config && m.config.name) || 'unknown';",
    "    process.send({ type: 'result', result: { agentId: process.env.KC_AGENT_ID, name, success: true, output: 'fixture-ok', toolUseCount: 0, totalTokensUsed: 7, duration: 5 } });",
    '  }',
    '});',
  ].join('\n'),
);

/**
 * Records every inbound protocol message plus the injected KC_* env vars to a
 * JSONL file, then delegates to the REAL TypeScript worker. This is how the
 * permission-cascade assertions observe what the backend actually sent over
 * IPC instead of trusting private state.
 */
const TAP_WORKER = writeFixture(
  'tap-worker.mjs',
  [
    "import fs from 'node:fs';",
    'const tapFile = process.env.KC_TAP_FILE;',
    'const record = (m) => {',
    '  try {',
    "    fs.appendFileSync(tapFile, JSON.stringify({ msg: m, env: { MODE: process.env.KC_PERMISSION_MODE, CWD: process.env.KC_CWD, AGENT: process.env.KC_AGENT_ID } }) + '\\n');",
    '  } catch {}',
    '};',
    "process.on('message', record);",
    'await import(process.env.KC_REAL_WORKER);',
  ].join('\n'),
);

const REAL_TS_WORKER = path.resolve(__dirname, '../../src/orchestrator/backends/subprocess-worker.ts');

/** Route the backend's hardcoded worker specifier at `target` for one spawn. */
function withWorkerTarget(target: string, extraEnv: Record<string, string> = {}): () => void {
  const prev: Record<string, string | undefined> = {
    NODE_OPTIONS: process.env.NODE_OPTIONS,
    KC_TEST_WORKER_TARGET: process.env.KC_TEST_WORKER_TARGET,
    ...Object.fromEntries(Object.keys(extraEnv).map((k) => [k, process.env[k]])),
  };
  process.env.NODE_OPTIONS = `--require ${REDIRECT_SHIM}`;
  process.env.KC_TEST_WORKER_TARGET = target;
  Object.assign(process.env, extraEnv);
  return () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

interface CollectedEvent {
  agentId: string;
  event: Record<string, unknown> & { type?: string };
}

function makeBackend(parentMode: PermissionMode, parentCwd = FIXTURE_DIR) {
  const bus = new EventBus();
  const backend = new SubprocessBackend(bus, [], parentMode, parentCwd);
  const collected: CollectedEvent[] = [];
  bus.onAny((agentId, event) => collected.push({ agentId, event: event as CollectedEvent['event'] }));
  return { bus, backend, collected };
}

type SpawnConfig = Partial<SubAgentSpawnConfig> & Pick<SubAgentSpawnConfig, 'name' | 'prompt'>;

async function spawnWith(backend: SubprocessBackend, config: SpawnConfig) {
  const full: SubAgentSpawnConfig = { systemPromptMode: 'default', ...config };
  // Minimal ToolUseContext — the subprocess backend only reads config fields.
  return backend.spawn(full, {} as unknown as ToolUseContext);
}

/** Resolves once `type` shows up on the bus (or null after `ms`). */
async function waitForEvent(
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

/** Polls until the agent leaves `spawning` (or `ms` elapses). */
async function waitReady(backend: SubprocessBackend, agentId: string, ms = 5000): Promise<string | null> {
  const deadline = Date.now() + ms;
  for (;;) {
    const status = backend.getStatus(agentId);
    if (status !== null && status !== 'spawning') return status;
    if (Date.now() > deadline) return status;
    await new Promise((r) => setTimeout(r, 50));
  }
}

interface TapLine {
  msg: { type: string; config?: Record<string, unknown>; permissionMode?: string; cwd?: string };
  env: { MODE?: string; CWD?: string; AGENT?: string };
}

function readTapLines(tapFile: string): TapLine[] {
  if (!fs.existsSync(tapFile)) return [];
  return fs
    .readFileSync(tapFile, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as TapLine);
}

afterAll(() => {
  fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

describe('SubprocessBackend (real child_process)', () => {
  describe('spawn startup and message protocol round-trip', () => {
    it('starts the real TS worker and surfaces its engine error instead of hanging', async () => {
      const { backend, collected } = makeBackend('default');
      const restore = withWorkerTarget(TAP_WORKER, {
        KC_REAL_WORKER: REAL_TS_WORKER,
        KC_TAP_FILE: path.join(FIXTURE_DIR, 'tap-startup.jsonl'),
      });
      let result;
      try {
        result = await spawnWith(backend, { name: 'starter', prompt: 'say hi' });
      } finally {
        restore();
      }

      // spawn() itself is fire-and-forget successful.
      expect(result.success).toBe(true);
      expect(result.agentId).toBe('starter@0');
      expect(result.queryEngine).toBeNull(); // no QueryEngine crosses the process boundary
      expect(collected.map((e) => e.event.type)).toContain('agent:subagent_spawned');

      // Real worker boots -> ready -> receives init -> engine loop fails fast
      // under native node (extensionless dynamic import). The failure must be
      // surfaced as an event + terminal status, never a hang.
      const failed = await waitForEvent(collected, 'agent:subagent_failed', 10000);
      expect(failed).not.toBeNull();
      expect(String((failed!.event as { error?: string }).error)).toContain('QueryEngine');
      expect(backend.getStatus(result.agentId)).toBe('failed');

      await backend.shutdownAll();
    }, 15000);

    it('propagates child-authored event/result envelopes verbatim over IPC', async () => {
      const { backend, collected } = makeBackend('default');
      const restore = withWorkerTarget(RESULT_WORKER);
      let result;
      try {
        result = await spawnWith(backend, { name: 'reporter', prompt: 'produce result' });
      } finally {
        restore();
      }

      const done = await waitForEvent(collected, 'agent:subagent_completed', 8000);
      expect(done).not.toBeNull();
      const res = done!.event.result as {
        agentId: string;
        name: string;
        success: boolean;
        output: string;
        totalTokensUsed: number;
      };
      // Child envelope passes through untouched (name echoed back from init config).
      expect(res.name).toBe('reporter'); // proves init.config reached the child
      expect(res.success).toBe(true);
      expect(res.output).toBe('fixture-ok');
      expect(res.totalTokensUsed).toBe(7);
      expect(res.agentId).toBe(result.agentId);
      expect(backend.getStatus(result.agentId)).toBe('completed');
      // cleanup delays map removal by 5s to drain pending queries.
      expect(backend.listActive()).toContain(result.agentId);
    }, 15000);
  });

  describe('timeout handling', () => {
    it('aborts an agent outliving timeoutSeconds: shutdown(force) escalates to SIGKILL -> cancelled', async () => {
      const { backend, collected } = makeBackend('default');
      const restore = withWorkerTarget(HANG_WORKER);
      let result;
      try {
        result = await spawnWith(backend, { name: 'hung', prompt: 'never finishes', timeoutSeconds: 1 });
      } finally {
        restore();
      }

      expect(await waitReady(backend, result.agentId)).toBe('running');

      const done = await waitForEvent(collected, 'agent:subagent_completed', 12000);
      expect(done).not.toBeNull();
      const res = done!.event.result as { success: boolean; output: string };
      expect(res.success).toBe(false);
      expect(res.output).toContain('signal SIGKILL'); // watchdog escalated past grace period
      expect(backend.getStatus(result.agentId)).toBe('cancelled');
    }, 20000);

    it('falls back to sending init when no ready arrives within 5s (FUN-01 defense)', async () => {
      const warnSpy = vi.spyOn(logger.orchestrator, 'warn').mockImplementation(() => {});
      const { backend } = makeBackend('default');
      const restore = withWorkerTarget(SILENT_WORKER);
      let result;
      try {
        result = await spawnWith(backend, { name: 'quiet', prompt: 'p' });
      } finally {
        restore();
      }

      // No ready ever arrives; after 5s the backend must send init anyway so
      // both sides never wait on each other.
      await new Promise((r) => setTimeout(r, 5800));
      expect(backend.getStatus(result.agentId)).toBe('running');
      expect(warnSpy.mock.calls.some(([msg]) => String(msg).includes('did not send ready'))).toBe(true);
      warnSpy.mockRestore();

      await backend.shutdownAll();
    }, 15000);
  });

  describe('crash / exit recovery', () => {
    it('surfaces a mid-run crash (exit code != 0) as failed completion with usage counters', async () => {
      const { backend, collected } = makeBackend('default');
      const restore = withWorkerTarget(CRASH_WORKER);
      let result;
      try {
        result = await spawnWith(backend, { name: 'crasher', prompt: 'boom' });
      } finally {
        restore();
      }

      const done = await waitForEvent(collected, 'agent:subagent_completed', 8000);
      expect(done).not.toBeNull();
      const res = done!.event.result as { success: boolean; output: string; toolUseCount: number; totalTokensUsed: number };
      expect(res.success).toBe(false);
      expect(res.output).toContain('code 3');
      // tool_completed events received before the crash were counted.
      expect(res.toolUseCount).toBe(1);
      expect(res.totalTokensUsed).toBe(42);
      expect(backend.getStatus(result.agentId)).toBe('failed');
    }, 15000);

    it('keeps the parent fully operational after a worker dies mid-run', async () => {
      const { backend, collected } = makeBackend('default');
      const restore = withWorkerTarget(HANG_WORKER);
      let victim;
      try {
        victim = await spawnWith(backend, { name: 'victim', prompt: 'p', timeoutSeconds: 30 });
      } finally {
        restore();
      }
      expect(await waitReady(backend, victim.agentId)).toBe('running');

      // force shutdown = abort broadcast + SIGKILL escalation; the runtime is
      // marked cancelled immediately rather than waiting for the exit event.
      expect(await backend.shutdown(victim.agentId, true)).toBe(true);
      expect(backend.getStatus(victim.agentId)).toBe('cancelled');
      await waitForEvent(collected, 'agent:subagent_completed', 8000); // exit still observed

      // Unknown ids stay clean failures after the crash.
      expect(await backend.shutdown('missing@99', true)).toBe(false);
      expect(backend.getStatus('missing@99')).toBeNull();

      // A fresh agent works and the agentId counter was not poisoned.
      const next = await spawnWith(backend, { name: 'after-crash', prompt: 'still alive' });
      expect(next.success).toBe(true);
      expect(next.agentId).toBe('after-crash@1');
      await backend.shutdownAll();
    }, 15000);

    it('records a clean exit (code 0) as a successful completion', async () => {
      const { backend, collected } = makeBackend('default');
      const restore = withWorkerTarget(GRACEFUL_WORKER);
      let result;
      try {
        result = await spawnWith(backend, { name: 'polite', prompt: 'finish cleanly' });
      } finally {
        restore();
      }
      expect(await waitReady(backend, result.agentId)).toBe('running');

      // Graceful shutdown is delivered over IPC; the child says goodbye first,
      // proving messages flow parent->child->parent while shutting down.
      expect(await backend.sendMessage(result.agentId, { type: 'user_message', from: 'parent@default', payload: { text: 'hello' } })).toBeUndefined();
      expect(await backend.shutdown(result.agentId, false)).toBe(true);

      const bye = await waitForEvent(collected, 'agent:text_delta', 5000);
      expect(bye).not.toBeNull();
      expect((bye!.event as { text?: string }).text).toBe('bye:polite');

      const done = await waitForEvent(collected, 'agent:subagent_completed', 5000);
      expect(done).not.toBeNull();
      expect((done!.event.result as { success: boolean }).success).toBe(true);
      expect(backend.getStatus(result.agentId)).toBe('completed');
    }, 15000);

    it('surfaces spawn errors (unusable cwd) as failures instead of hanging', async () => {
      const { backend } = makeBackend('default');
      const restore = withWorkerTarget(HANG_WORKER);
      let result;
      try {
        result = await spawnWith(backend, { name: 'badcwd', prompt: 'p', cwd: '/nonexistent-kc-t14-zzz' });
      } finally {
        restore();
      }
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline && backend.getStatus(result.agentId) !== 'failed') {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(backend.getStatus(result.agentId)).toBe('failed');
    }, 15000);
  });

  describe('permission cascade propagation', () => {
    it.skipIf(!tsWorkersSupported)(
      'delivers derived permission mode, config and cwd to the real worker over IPC',
      async () => {
        const cases: Array<{
          parent: PermissionMode;
          requested?: PermissionMode;
          cwdOverride?: string;
          label: string;
          expectedMode: PermissionMode;
        }> = [
          { parent: 'auto', requested: 'default', label: 'auto-child-default', expectedMode: 'default' },
          { parent: 'default', requested: 'auto', label: 'clamp-down', expectedMode: 'default' }, // may not exceed parent
          { parent: 'dontAsk', requested: 'bypassPermissions', label: 'dontask-locked', expectedMode: 'dontAsk' }, // bypass request refused
          { parent: 'acceptEdits', requested: undefined, cwdOverride: path.join(FIXTURE_DIR, 'cwdir'), label: 'inherit-cwd', expectedMode: 'acceptEdits' },
        ];
        fs.mkdirSync(path.join(FIXTURE_DIR, 'cwdir'), { recursive: true });

        const suites = cases.map((c) => makeBackend(c.parent, c.cwdOverride ?? FIXTURE_DIR));
        // Spawns are serialized because the worker target is routed through
        // process.env: each spawn must see its own KC_TAP_FILE while it forks.
        for (let i = 0; i < cases.length; i++) {
          const restore = withWorkerTarget(TAP_WORKER, {
            KC_REAL_WORKER: REAL_TS_WORKER,
            KC_TAP_FILE: path.join(FIXTURE_DIR, `tap-cascade.${i}.jsonl`),
          });
          try {
            await spawnWith(suites[i].backend, {
              name: cases[i].label,
              prompt: 'check cascade',
              permissions: cases[i].requested,
              ...(cases[i].cwdOverride ? { cwd: cases[i].cwdOverride } : {}),
            });
          } finally {
            restore();
          }
        }

        // Wait until every child has recorded its init receipt.
        const deadline = Date.now() + 10000;
        for (let i = 0; i < cases.length; i++) {
          while (Date.now() < deadline && !readTapLines(path.join(FIXTURE_DIR, `tap-cascade.${i}.jsonl`)).some((l) => l.msg.type === 'init')) {
            await new Promise((r) => setTimeout(r, 100));
          }
        }

        cases.forEach((c, i) => {
          const lines = readTapLines(path.join(FIXTURE_DIR, `tap-cascade.${i}.jsonl`));
          const inits = lines.filter((l) => l.msg.type === 'init');
          expect(inits.length, `case ${c.label}: exactly one init delivered`).toBe(1);
          const init = inits[0];

          // The cascader matrix agrees with what the backend derived...
          expect(deriveChildPermissions(c.parent, c.requested)).toBe(c.expectedMode);
          // ...and the child received the derived mode via payload AND env.
          expect(init.msg.permissionMode).toBe(c.expectedMode);
          expect(init.env.MODE).toBe(c.expectedMode);
          // Spawn config travels intact.
          expect(init.msg.config?.name).toBe(c.label);
          expect(init.msg.config?.prompt).toBe('check cascade');
          expect(init.msg.config?.systemPromptMode).toBe('default');
          // cwd: explicit override wins, otherwise the parent's cwd is inherited.
          const expectedCwd = c.cwdOverride ?? FIXTURE_DIR;
          expect(init.msg.cwd).toBe(expectedCwd);
          expect(init.env.CWD).toBe(expectedCwd);
          // Identity injection follows the documented "<name>@<counter>" scheme.
          expect(init.env.AGENT).toBe(`${c.label}@0`);
        });

        await Promise.all(suites.map((s) => s.backend.shutdownAll()));
      },
      20000,
    );

    it('derives child modes consistently with the shared cascader matrix', () => {
      // Same assertion style as test/integration/multi-agent.test.ts, applied
      // to the exact parent/requested pairs the spawn path feeds in.
      expect(deriveChildPermissions('bypassPermissions', undefined)).toBe('bypassPermissions');
      expect(deriveChildPermissions('bypassPermissions', 'auto')).toBe('auto');
      expect(deriveChildPermissions('auto', undefined)).toBe('auto');
      expect(deriveChildPermissions('auto', 'default')).toBe('default');
      // A child may never escalate beyond its parent.
      expect(deriveChildPermissions('default', 'auto')).toBe('default');
      expect(deriveChildPermissions('plan', 'bypassPermissions')).toBe('plan');
      // dontAsk locks children out entirely, even from bypass requests.
      expect(deriveChildPermissions('dontAsk', 'bypassPermissions')).toBe('dontAsk');
      expect(deriveChildPermissions('acceptEdits', undefined)).toBe('acceptEdits');
    });
  });

  describe('lifecycle API surface', () => {
    it('tracks status/listActive and answers shutdownAll', async () => {
      const { backend, collected } = makeBackend('default');
      expect(backend.listActive()).toEqual([]);
      expect(backend.getStatus('nobody@0')).toBeNull();
      expect(await backend.shutdown('nobody@0')).toBe(false);

      const restore = withWorkerTarget(HANG_WORKER);
      let a;
      let b;
      try {
        a = await spawnWith(backend, { name: 'batch-a', prompt: 'p', timeoutSeconds: 30 });
        b = await spawnWith(backend, { name: 'batch-b', prompt: 'p', timeoutSeconds: 30 });
      } finally {
        restore();
      }
      expect(await waitReady(backend, a.agentId)).toBe('running');
      expect(await waitReady(backend, b.agentId)).toBe('running');
      expect(backend.listActive()).toEqual([a.agentId, b.agentId]);
      expect(collected.length).toBeGreaterThanOrEqual(2); // spawned events

      await backend.shutdownAll();
      expect(backend.getStatus(a.agentId)).toBe('cancelled');
      expect(backend.getStatus(b.agentId)).toBe('cancelled');
    }, 15000);
  });
});
