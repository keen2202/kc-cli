import { logger } from '../../services/logger';
// In-process backend for sub-agent execution
// Uses AsyncLocalStorage for async context isolation

import { AsyncLocalStorage } from 'async_hooks';
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
import { EventBus } from '../event-bus.js';
import {
  deriveChildPermissions,
  buildChildToolAllowList,
  createChildPermissionContext,
} from '../permission-cascader.js';
import { ResultAggregator } from '../result-aggregator.js';
import { createExecutionTrace, runWithExecutionTrace, type ExecutionTrace } from '../../services/execution-env';
import { createScopedState, runWithScopedState, getState } from '../../bootstrap/state';
import {
  BaseSubAgentBackend,
  createAgentIdCounter,
  createSubAgentRuntime,
  capMessageQueue,
  resolveTimeoutMs,
} from './backend-shared.js';

// Async context store for sub-agent isolation
const agentContextStore = new AsyncLocalStorage<SubAgentRuntime>();

// Cached QueryEngine class to avoid repeated dynamic import on every spawn
let CachedQueryEngine: (new (config: Record<string, unknown>, tools: unknown[]) => QueryEngineLike) | null = null;

/**
 * Reset the cached QueryEngine (for testing)
 */
export function resetCachedQueryEngine(): void {
  CachedQueryEngine = null;
}

/**
 * Get current sub-agent context from AsyncLocalStorage
 */
export function getCurrentAgentContext(): SubAgentRuntime | undefined {
  return agentContextStore.getStore();
}

/**
 * InProcessBackend - Executes sub-agents in the same process
 * with AsyncLocalStorage-based context isolation
 */
export class InProcessBackend extends BaseSubAgentBackend implements SubAgentBackend {
  readonly type = 'in_process' as const;

  private eventBus: EventBus;
  private allTools: Map<string, ToolDefinition>;
  private parentPermissionMode: PermissionMode;
  private parentCwd: string;
  private nextAgentId = createAgentIdCounter();
  /** Completed runtimes retained briefly so the report gate can resume them. */
  private completedAgents = new Map<string, SubAgentRuntime>();
  /** Parent context retained for resume() calls. */
  private parentContexts = new Map<string, ToolUseContext>();
  /** Per-agent trace reused across report follow-up turns. */
  private executionTraces = new Map<string, ExecutionTrace>();

  constructor(
    eventBus: EventBus,
    allTools: ToolDefinition[],
    parentPermissionMode: PermissionMode,
    parentCwd: string
  ) {
    super();
    this.eventBus = eventBus;
    this.allTools = new Map(allTools.map((t) => [t.name, t]));
    this.parentPermissionMode = parentPermissionMode;
    this.parentCwd = parentCwd;
  }

  /**
   * Spawn a new sub-agent
   */
  async spawn(
    config: SubAgentSpawnConfig,
    parentContext: ToolUseContext
  ): Promise<SpawnResult> {
    const agentId = this.nextAgentId(config.name);
    const startedAt = Date.now();

    try {
      // Derive child permissions
      const childPermissionMode = deriveChildPermissions(
        this.parentPermissionMode,
        config.permissions
      );

      // Determine child working directory
      const childCwd = config.cwd || this.parentCwd;

      // Create scoped state for per-agent isolation
      const scopedState = createScopedState(getState(), {
        cwd: childCwd,
        permissionMode: childPermissionMode,
      });

      // Build allowed tool list
      const parentTools = Array.from(this.allTools.keys()) as ToolName[];
      const allowedToolNames = buildChildToolAllowList(parentTools, {
        tools: config.tools,
        deniedTools: config.deniedTools,
      });

      // Filter tools - use Set for O(1) lookup instead of O(n) Array.includes
      const allowedToolNamesSet = new Set(allowedToolNames);
      const childTools = Array.from(this.allTools.values()).filter((tool) =>
        allowedToolNamesSet.has(tool.name as ToolName)
      );

      // Create runtime (shared builder supplies abortController + counters)
      const runtime = createSubAgentRuntime(agentId, config, startedAt);

      // Store runtime
      this.activeAgents.set(agentId, runtime);
      this.parentContexts.set(agentId, parentContext);

      // Update status
      runtime.status = 'running';

      // Emit spawned event
      this.eventBus.emit(agentId, {
        type: 'agent:subagent_spawned',
        agentId,
        name: config.name,
        timestamp: Date.now(),
      });

      // Create child permission context
      const childPermissionContext = createChildPermissionContext(
        parentContext.permissions,
        childPermissionMode
      );

      // Create QueryEngine for sub-agent
      // Cache the import to avoid repeated module resolution on every spawn
      if (!CachedQueryEngine) {
        const mod = await import('../../query/QueryEngine');
        CachedQueryEngine = mod.QueryEngine as unknown as typeof CachedQueryEngine;
      }
      const QueryEngineClass = CachedQueryEngine!;

      // Create QueryEngine and run agent loop inside scoped state context
      // so that getState() returns the isolated child state for all operations
      // within the child agent's async execution chain.
      const queryEngine = runWithScopedState(scopedState, () => {
        const qe = new QueryEngineClass(
          {
            model: config.model || 'claude-sonnet-4-20250514',
            provider: 'anthropic',
            maxTurns: config.maxTurns || 15,
            maxBudgetUsd: null,
            systemPrompt: config.systemPrompt,
          },
          childTools
        );

        runtime.queryEngine = qe;

        // Start agent loop asynchronously — the ALS context from runWithScopedState
        // propagates through the entire promise chain, keeping getState() scoped.
        this.runAgentLoop(runtime, parentContext, qe).catch((error) => {
          logger.orchestrator.error(`Agent ${agentId} loop error:`, error);
          runtime.status = 'failed';
          runtime.error = error;
          runtime.completedAt = Date.now();

          this.terminalGuard.emitOnce(agentId, this.eventBus, {
              type: 'agent:subagent_failed',
              agentId,
              error: error.message || String(error),
              timestamp: Date.now(),
            });
        });

        // Wire up abort controller to query engine
        runtime.abortController.signal.addEventListener('abort', () => {
          qe.abort('Sub-agent timeout or cancellation requested');
        }, { once: true });

        return qe;
      });

      return {
        agentId,
        success: true,
        queryEngine,
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

  /**
   * Run the agent loop for a sub-agent
   */
  private async runAgentLoop(
    runtime: SubAgentRuntime,
    _parentContext: ToolUseContext,
    queryEngine: QueryEngineLike,
    promptOverride?: string,
  ): Promise<void> {
    const { config, abortController } = runtime;
    const agentId = runtime.identity.agentId;
    const executionTrace = this.executionTraces.get(agentId) ?? createExecutionTrace(config.cwd ?? this.parentCwd);
    this.executionTraces.set(agentId, executionTrace);

    // Wrap in AsyncLocalStorage for context isolation and install the bounded
    // RI-SPEC §3.3 execution trace for all tool calls in this async chain.
    await runWithExecutionTrace(executionTrace, () => agentContextStore.run(runtime, async () => {
      try {
        // Set up timeout
        const timeoutMs = resolveTimeoutMs(config.timeoutSeconds);
        const timeoutId = setTimeout(() => {
          abortController.abort();
        }, timeoutMs);

        // Submit message and collect events
        const eventGenerator = queryEngine.submitMessage(promptOverride ?? config.prompt);

        let lastAssistantMessage = '';
        let hasToolCalls = false;

        for await (const rawEvent of eventGenerator) {
          // Check if aborted
          if (abortController.signal.aborted) {
            break;
          }

          // Forward event to parent via EventBus
          this.eventBus.emit(agentId, rawEvent as AgentEvent);

          // Collect final message from agent-prefixed events
          const event = rawEvent as AgentEvent;
          if (event.type === 'agent:text_delta') {
            lastAssistantMessage += event.text;
          } else if (event.type === 'agent:turn_complete') {
            if (event.message?.content) {
              lastAssistantMessage = event.message.content;
            }
            if (event.message?.toolCalls && event.message.toolCalls.length > 0) {
              hasToolCalls = true;
              runtime.toolUseCount += event.message.toolCalls.length;
            }
          } else if (event.type === 'agent:tool_completed') {
            const tokensUsed = Number(event.result?.metadata?.tokensUsed) || 0;
            runtime.totalTokensUsed += tokensUsed;
          }
        }

        clearTimeout(timeoutId);

        // Determine completion status
        const isTimedOut = abortController.signal.aborted;
        const duration = Date.now() - runtime.startedAt;

        if (isTimedOut) {
          runtime.status = 'timed_out';
          this.terminalGuard.emitOnce(agentId, this.eventBus, {
              type: 'agent:subagent_timed_out',
              agentId,
              elapsed: Math.round(duration / 1000),
              timestamp: Date.now(),
            });
        } else {
          runtime.status = 'completed';
          runtime.completedAt = Date.now();

          const result: SubAgentResult = {
            agentId,
            name: config.name,
            success: true,
            output: lastAssistantMessage || 'No output generated',
            toolUseCount: runtime.toolUseCount,
            totalTokensUsed: runtime.totalTokensUsed,
            duration,
            meta: { executionTrace, trace: executionTrace },
          };

          this.terminalGuard.emitOnce(agentId, this.eventBus, {
              type: 'agent:subagent_completed',
              agentId,
              result,
              timestamp: Date.now(),
            });
        }
      } catch (error) {
        runtime.status = 'failed';
        runtime.error = error instanceof Error ? error : new Error(String(error));
        runtime.completedAt = Date.now();

        this.terminalGuard.emitOnce(agentId, this.eventBus, {
            type: 'agent:subagent_failed',
            agentId,
            error: runtime.error.message,
            timestamp: Date.now(),
          });
      } finally {
        // A report-gate follow-up may have synchronously flipped the runtime
        // back to `running` while the completion event was being dispatched.
        // Only clean up when this loop is genuinely terminal.
        if (runtime.status !== 'running') {
          this.activeAgents.delete(agentId);
        }
        const gated = Boolean(config.reportPolicy) ||
          (Array.isArray(config.checkpoints) && config.checkpoints.length > 0);
        if (runtime.status === 'completed' && gated) {
          // Retain just enough state for a possible follow-up resume; the
          // orchestrator releases it once the report gate reaches a verdict.
          this.completedAgents.set(agentId, runtime);
        } else if (runtime.status !== 'running') {
          this.executionTraces.delete(agentId);
          this.parentContexts.delete(agentId);
        }
      }
    }));
  }

  /**
   * Resume a completed sub-agent with one controller follow-up message. The
   * QueryEngine keeps its conversation state, so `submitMessage(message)`
   * appends the follow-up as a new user turn.
   */
  async resume(agentId: string, message: string): Promise<boolean> {
    const runtime = this.activeAgents.get(agentId) ?? this.completedAgents.get(agentId);
    const parentContext = this.parentContexts.get(agentId);
    if (!runtime?.queryEngine || !parentContext || runtime.status === 'running') {
      return false;
    }

    this.completedAgents.delete(agentId);
    this.activeAgents.set(agentId, runtime);
    runtime.status = 'running';
    runtime.completedAt = undefined;
    runtime.error = undefined;
    this.terminalGuard.reset(agentId);

    void this.runAgentLoop(runtime, parentContext, runtime.queryEngine, message);
    return true;
  }

  /**
   * Drop the runtime/trace retained for a report-gate resume. Safe to call
   * for non-gated agents (no-op).
   */
  releaseReportContext(agentId: string): void {
    this.completedAgents.delete(agentId);
    this.parentContexts.delete(agentId);
    this.executionTraces.delete(agentId);
  }

  /** Clear any retained completion state. */
  override async shutdownAll(): Promise<void> {
    await super.shutdownAll();
    this.completedAgents.clear();
    this.parentContexts.clear();
    this.executionTraces.clear();
  }

  /** Per-agent message queues for inter-agent communication */
  private messageQueues = new Map<string, Array<SubAgentMessage>>();

  /**
   * Send a message to a sub-agent via EventBus.
   * Messages are emitted as inter-agent events on the target agent's namespace
   * for async consumption, and also queued for sync polling.
   */
  async sendMessage(agentId: string, message: SubAgentMessage): Promise<void> {
    const runtime = this.activeAgents.get(agentId);
    if (!runtime) {
      throw new Error(`Agent ${agentId} not found`);
    }

    // Queue the message for sync access
    if (!this.messageQueues.has(agentId)) {
      this.messageQueues.set(agentId, []);
    }
    const queue = this.messageQueues.get(agentId)!;
    capMessageQueue(queue); // Cap queue size
    queue.push(message);

    // Emit as inter-agent event on the target agent's EventBus
    this.eventBus.emit(agentId, {
      type: 'agent:inter_agent_message',
      agentId,
      from: message.from,
      messageType: message.type,
      payload: message.payload,
      timestamp: Date.now(),
    } as unknown as AgentEvent);

    logger.orchestrator.info(
      `Message to ${agentId} from ${message.from}: type=${message.type}`
    );

    // Handle shutdown messages immediately
    if (message.type === 'shutdown') {
      await this.shutdown(agentId, false);
    }
  }

  /**
   * Drain pending messages for an agent (for polling).
   */
  drainMessages(agentId: string): SubAgentMessage[] {
    const queue = this.messageQueues.get(agentId);
    if (!queue || queue.length === 0) return [];
    const drained = [...queue];
    queue.length = 0;
    return drained;
  }

  /**
   * Shutdown a sub-agent
   */
  async shutdown(agentId: string, force = false): Promise<boolean> {
    const runtime = this.activeAgents.get(agentId);
    if (!runtime) {
      return false;
    }

    if (force) {
      runtime.abortController.abort();
      runtime.status = 'cancelled';
      runtime.completedAt = Date.now();

      this.terminalGuard.emitOnce(agentId, this.eventBus, {
          type: 'agent:subagent_cancelled',
          agentId,
          timestamp: Date.now(),
        });

      this.activeAgents.delete(agentId);
      return true;
    }

    // Graceful shutdown: wait for current tool to complete
    runtime.abortController.abort();
    return true;
  }

  // getStatus / listActive / shutdownAll are inherited from BaseSubAgentBackend
  // (T26: one shared implementation for both backends).
}
