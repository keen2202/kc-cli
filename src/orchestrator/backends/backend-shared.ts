// Shared sub-agent backend runtime — round4 §6-M1 (T26)
//
// The two backends (in-process, subprocess) had drifted: the in-process one
// guarded against duplicate terminal events (FUN-07), the subprocess one did
// not. This module extracts the duplicated lifecycle pieces and the terminal
// guard so both backends share one implementation.

import type { EventBus } from '../event-bus.js';
import type {
  SubAgentRuntime,
  SubAgentSpawnConfig,
  SubAgentStatus,
  SubAgentMessage,
} from '../types.js';
import type { AgentEvent } from '../../state/types.js';

/** Monotonic per-backend agent id counter: `<name>@<n>`. */
export function createAgentIdCounter(): (name: string) => string {
  let counter = 0;
  return (name: string) => `${name}@${counter++}`;
}

/** Build the runtime record every backend creates right after accept. */
export function createSubAgentRuntime(
  agentId: string,
  config: SubAgentSpawnConfig,
  startedAt: number,
): SubAgentRuntime {
  return {
    identity: {
      agentId,
      name: config.name,
      team: 'default',
      parentId: null,
    },
    status: 'spawning',
    config,
    queryEngine: null,
    abortController: new AbortController(),
    startedAt,
    completedAt: undefined,
    toolUseCount: 0,
    totalTokensUsed: 0,
  };
}

/** Shared timeout expression: invalid/missing `timeoutSeconds` falls back to 300s. */
export function resolveTimeoutMs(timeoutSeconds: number | undefined, fallbackSeconds = 300): number {
  return (Number.isFinite(timeoutSeconds ?? NaN) ? timeoutSeconds! : fallbackSeconds) * 1000;
}

/** Cap an inter-agent message queue in place (prevents unbounded growth). */
export function capMessageQueue(queue: SubAgentMessage[], max = 256): void {
  if (queue.length >= max) {
    queue.splice(0, queue.length - max + 1);
  }
}

/**
 * FUN-07 guard, shared by both backends: a terminal event
 * (completed / failed / timed_out / cancelled) must be emitted at most once
 * per agent — duplicate emissions corrupt the aggregator and leak permits.
 */
export class TerminalEventGuard {
  private sent = new Set<string>();

  hasSent(agentId: string): boolean {
    return this.sent.has(agentId);
  }

  /** Emit `event` on `eventBus` unless a terminal event already went out for this agent. */
  emitOnce(agentId: string, eventBus: EventBus, event: AgentEvent): boolean {
    if (this.sent.has(agentId)) return false;
    this.sent.add(agentId);
    eventBus.emit(agentId, event);
    return true;
  }
}

/**
 * Lifecycle plumbing common to both backends. Subclasses own their transport
 * (ALS scope vs child process) and provide spawn/sendMessage/shutdown.
 */
export abstract class BaseSubAgentBackend {
  abstract readonly type: 'in_process' | 'subprocess';

  protected activeAgents: Map<string, SubAgentRuntime> = new Map();
  protected terminalGuard = new TerminalEventGuard();

  abstract spawn(
    config: SubAgentSpawnConfig,
    parentContext: import('../../tools/protocol.js').ToolUseContext,
  ): Promise<import('../types.js').SpawnResult>;

  abstract sendMessage(agentId: string, message: SubAgentMessage): Promise<void>;

  abstract shutdown(agentId: string, force?: boolean): Promise<boolean>;

  getStatus(agentId: string): SubAgentStatus | null {
    return this.activeAgents.get(agentId)?.status || null;
  }

  listActive(): string[] {
    return Array.from(this.activeAgents.keys());
  }

  async shutdownAll(): Promise<void> {
    const agentIds = this.listActive();
    await Promise.all(agentIds.map((id) => this.shutdown(id, true)));
  }
}
