// Subprocess backend for sub-agent execution
// Uses child_process.fork() for process-level isolation

import { fork, type ChildProcess } from 'child_process';
import * as path from 'path';
import { logger } from '../../services/logger';
import { EventBus } from '../event-bus.js';
import type { SubAgentBackend } from './types.js';
import type {
  SubAgentSpawnConfig,
  SubAgentRuntime,
  SubAgentStatus,
  SpawnResult,
  SubAgentMessage,
  SubAgentResult,
  QueryEngineLike,
} from '../types.js';
import type { ToolUseContext, ToolDefinition, ToolName } from '../../tools/protocol.js';
import type { PermissionMode } from '../../permissions/protocol.js';
import type { AgentEvent } from '../../state/types.js';
import {
  deriveChildPermissions,
  buildChildToolAllowList,
  createChildPermissionContext,
} from '../permission-cascader.js';
import {
  BaseSubAgentBackend,
  createAgentIdCounter,
  createSubAgentRuntime,
  capMessageQueue,
  resolveTimeoutMs,
} from './backend-shared.js';

// IPC message types for parent↔child communication
interface ParentMessage {
  type: 'init' | 'shutdown' | 'message';
  config?: SubAgentSpawnConfig;
  tools?: Array<{ name: string; description: string }>;
  permissionMode?: string;
  cwd?: string;
  message?: SubAgentMessage;
  force?: boolean;
}

interface ChildMessage {
  type: 'event' | 'result' | 'error' | 'ready';
  event?: AgentEvent;
  result?: SubAgentResult;
  error?: { message: string; stack?: string };
}

/**
 * SubprocessBackend - Executes sub-agents in separate child processes
 * using Node.js child_process.fork() for true process-level isolation.
 *
 * Each sub-agent runs in its own process with a restricted view of the
 * filesystem and isolated memory. IPC serialization provides the
 * communication boundary.
 */
export class SubprocessBackend extends BaseSubAgentBackend implements SubAgentBackend {
  readonly type = 'subprocess' as const;

  private processes: Map<string, ChildProcess> = new Map();
  private messageQueues: Map<string, Array<SubAgentMessage>> = new Map();
  /** Pending 5s removal timers per agent, so cleanup() cannot stack duplicates. */
  private cleanupTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private eventBus: EventBus;
  private parentPermissionMode: PermissionMode;
  private parentCwd: string;
  private nextAgentId = createAgentIdCounter();

  constructor(
    eventBus: EventBus,
    _allTools: ToolDefinition[],
    parentPermissionMode: PermissionMode,
    parentCwd: string
  ) {
    super();
    this.eventBus = eventBus;
    this.parentPermissionMode = parentPermissionMode;
    this.parentCwd = parentCwd;
  }

  async spawn(
    config: SubAgentSpawnConfig,
    parentContext: ToolUseContext
  ): Promise<SpawnResult> {
    const agentId = this.nextAgentId(config.name);
    const startedAt = Date.now();

    // PERF-03: Timer handle tracking for cleanup
    let killTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let runtimeTimeoutHandle: ReturnType<typeof setTimeout> | undefined;

    try {
      // Derive child permissions
      const childPermissionMode = deriveChildPermissions(
        this.parentPermissionMode,
        config.permissions
      );

      // Determine the worker script path
      const workerPath = path.resolve(__dirname, 'subprocess-worker.js');

      // Spawn child process with IPC channel
      const child = fork(workerPath, [], {
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        env: {
          ...process.env,
          KC_AGENT_ID: agentId,
          KC_PERMISSION_MODE: childPermissionMode,
          KC_CWD: config.cwd || this.parentCwd,
        },
        cwd: config.cwd || this.parentCwd,
      });

      // Create runtime (shared builder supplies abortController + counters)
      const runtime = createSubAgentRuntime(agentId, config, startedAt);

      this.activeAgents.set(agentId, runtime);
      this.processes.set(agentId, child);

      // Handle messages from child
      child.on('message', (msg: ChildMessage) => {
        if (!msg || typeof msg !== 'object') return;

        switch (msg.type) {
          case 'ready': {
            runtime.status = 'running';
            clearTimeout(readyTimeout);
            // Send init message with config
            const initMsg: ParentMessage = {
              type: 'init',
              config,
              permissionMode: childPermissionMode,
              cwd: config.cwd || this.parentCwd,
            };
            child.send(initMsg);
            break;
          }

          case 'event': {
            if (msg.event) {
              this.eventBus.emit(agentId, msg.event);
              // Track tool usage from events
              if (msg.event.type === 'agent:tool_completed') {
                runtime.toolUseCount++;
                const tokens = Number(msg.event.result?.metadata?.tokensUsed) || 0;
                runtime.totalTokensUsed += tokens;
              }
            }
            break;
          }

          case 'result': {
            if (msg.result) {
              // PERF-03: Clear timers before cleanup
              clearTimeout(readyTimeout);
              if (killTimeoutHandle !== undefined) clearTimeout(killTimeoutHandle);
              if (runtimeTimeoutHandle !== undefined) clearTimeout(runtimeTimeoutHandle);
              runtime.status = 'completed';
              runtime.completedAt = Date.now();
              // T26 (M1): terminal-event guard shared with the in-process
              // backend — duplicate result/exit events must not double-emit.
              this.terminalGuard.emitOnce(agentId, this.eventBus, {
                type: 'agent:subagent_completed',
                agentId,
                result: msg.result,
                timestamp: Date.now(),
              } as AgentEvent);
              this.cleanup(agentId);
            }
            break;
          }

          case 'error': {
            // PERF-03: Clear timers before cleanup
            clearTimeout(readyTimeout);
            if (killTimeoutHandle !== undefined) clearTimeout(killTimeoutHandle);
            if (runtimeTimeoutHandle !== undefined) clearTimeout(runtimeTimeoutHandle);
            runtime.status = 'failed';
            runtime.error = new Error(msg.error?.message || 'Unknown subprocess error');
            runtime.completedAt = Date.now();
            // T26 (M1): guarded, as above.
            this.terminalGuard.emitOnce(agentId, this.eventBus, {
              type: 'agent:subagent_failed',
              agentId,
              error: runtime.error.message,
              timestamp: Date.now(),
            } as AgentEvent);
            this.cleanup(agentId);
            break;
          }
        }
      });

      // Handle child process exit
      child.on('exit', (code, signal) => {
        // PERF-03: Clear timers on process exit
        clearTimeout(readyTimeout);
        if (killTimeoutHandle !== undefined) clearTimeout(killTimeoutHandle);
        if (runtimeTimeoutHandle !== undefined) clearTimeout(runtimeTimeoutHandle);
        if (runtime.status === 'running') {
          if (signal) {
            runtime.status = 'cancelled';
          } else if (code !== 0) {
            runtime.status = 'failed';
            runtime.error = new Error(`Subprocess exited with code ${code}`);
          } else {
            runtime.status = 'completed';
          }
          runtime.completedAt = Date.now();
          // T26 (M1): guarded, as above.
          this.terminalGuard.emitOnce(agentId, this.eventBus, {
            type: 'agent:subagent_completed',
            agentId,
            result: {
              agentId,
              name: config.name,
              success: runtime.status === 'completed',
              output: `Process exited with code ${code}${signal ? ` signal ${signal}` : ''}`,
              toolUseCount: runtime.toolUseCount,
              totalTokensUsed: runtime.totalTokensUsed,
              duration: Date.now() - startedAt,
            },
            timestamp: Date.now(),
          } as AgentEvent);
          this.cleanup(agentId);
        }
        this.processes.delete(agentId);
      });

      child.on('error', (err) => {
        // PERF-03: Clear timers on process error
        clearTimeout(readyTimeout);
        if (killTimeoutHandle !== undefined) clearTimeout(killTimeoutHandle);
        if (runtimeTimeoutHandle !== undefined) clearTimeout(runtimeTimeoutHandle);
        runtime.status = 'failed';
        runtime.error = err;
        runtime.completedAt = Date.now();
        this.cleanup(agentId);
      });

      // Safety timeout: if child doesn't send 'ready' within 5s, send init
      // anyway to avoid deadlock (FUN-01 defense-in-depth)
      const readyTimeout = setTimeout(() => {
        if (runtime.status === 'spawning') {
          logger.orchestrator.warn(`[SubprocessBackend] Child ${agentId} did not send ready, sending init anyway`);
          runtime.status = 'running';
          child.send({
            type: 'init',
            config,
            permissionMode: childPermissionMode,
            cwd: config.cwd || this.parentCwd,
          } as ParentMessage);
        }
      }, 5000);
      // M9j: a stuck child must never delay process exit.
      readyTimeout.unref?.();

      // Wire abort controller
      runtime.abortController.signal.addEventListener('abort', () => {
        const abortMsg: ParentMessage = { type: 'shutdown', force: true };
        child.send(abortMsg);
        killTimeoutHandle = setTimeout(() => {
          if (!child.killed) child.kill('SIGKILL');
        }, 5000);
        killTimeoutHandle.unref?.();
      }, { once: true });

      // Set up timeout
      const timeoutMs = resolveTimeoutMs(config.timeoutSeconds);
      runtimeTimeoutHandle = setTimeout(() => {
        if (runtime.status === 'running') {
          runtime.abortController.abort();
        }
      }, timeoutMs);
      runtimeTimeoutHandle.unref?.();

      this.eventBus.emit(agentId, {
        type: 'agent:subagent_spawned',
        agentId,
        name: config.name,
        timestamp: Date.now(),
      } as AgentEvent);

      return {
        agentId,
        success: true,
        queryEngine: null, // No direct QueryEngine access across process boundary
      };
    } catch (error) {
      return {
        agentId,
        success: false,
        error: error instanceof Error ? error.message : String(error),
        queryEngine: null,
      };
    }
  }

  async sendMessage(agentId: string, message: SubAgentMessage): Promise<void> {
    const child = this.processes.get(agentId);
    if (!child || child.killed) {
      throw new Error(`Agent ${agentId} not found or process dead`);
    }

    // Queue for sync access
    if (!this.messageQueues.has(agentId)) {
      this.messageQueues.set(agentId, []);
    }
    const queue = this.messageQueues.get(agentId)!;
    capMessageQueue(queue);
    queue.push(message);

    // Forward to child via IPC
    const msg: ParentMessage = { type: 'message', message };
    child.send(msg);

    if (message.type === 'shutdown') {
      const shutdownMsg: ParentMessage = { type: 'shutdown' };
      child.send(shutdownMsg);
    }
  }

  async shutdown(agentId: string, force = false): Promise<boolean> {
    const runtime = this.activeAgents.get(agentId);
    const child = this.processes.get(agentId);
    if (!runtime || !child) return false;

    const msg: ParentMessage = { type: 'shutdown', force };
    child.send(msg);

    if (force) {
      runtime.status = 'cancelled';
      runtime.completedAt = Date.now();
      // M9j: this timer only escalates an already-requested shutdown; it must
      // never keep the event loop alive or hold up process exit.
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 2000).unref?.();
      this.cleanup(agentId);
    }

    return true;
  }

  // getStatus / listActive / shutdownAll are inherited from BaseSubAgentBackend
  // (T26: one shared implementation for both backends).

  private cleanup(agentId: string): void {
    const child = this.processes.get(agentId);
    if (child && !child.killed) {
      child.kill('SIGTERM');
    }
    // M9j: idempotent, unref'd, and cleared on re-entry. Previously each call
    // stacked another 5s timer for the same agent, and a pending timer kept the
    // process alive after every agent had already exited.
    const existing = this.cleanupTimers.get(agentId);
    if (existing) clearTimeout(existing);

    // Delay removal to allow pending queries
    const timer = setTimeout(() => {
      this.cleanupTimers.delete(agentId);
      // Guard against re-addition between delete and this callback.
      if (!this.processes.has(agentId)) return;
      this.activeAgents.delete(agentId);
      this.processes.delete(agentId);
      this.messageQueues.delete(agentId);
    }, 5000);
    timer.unref?.();
    this.cleanupTimers.set(agentId, timer);
  }
}
