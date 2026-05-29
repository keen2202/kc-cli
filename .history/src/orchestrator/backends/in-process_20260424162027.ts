// In-process backend for sub-agent execution
// Uses AsyncLocalStorage for async context isolation

import { AsyncLocalStorage } from 'async_hooks';
import type { SubAgentBackend } from './types';
import type {
  SubAgentSpawnConfig,
  SubAgentRuntime,
  SubAgentStatus,
  SpawnResult,
  SubAgentMessage,
  SubAgentResult,
} from '../types';
import type { ToolUseContext, ToolDefinition, ToolName } from '../../types/tools';
import type { PermissionMode } from '../../types/permissions';
import { EventBus } from '../event-bus';
import {
  deriveChildPermissions,
  buildChildToolAllowList,
  createChildPermissionContext,
} from '../permission-cascader';
import { ResultAggregator } from '../result-aggregator';

// Async context store for sub-agent isolation
const agentContextStore = new AsyncLocalStorage<SubAgentRuntime>();

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
export class InProcessBackend implements SubAgentBackend {
  readonly type = 'in_process' as const;

  private activeAgents: Map<string, SubAgentRuntime> = new Map();
  private eventBus: EventBus;
  private allTools: Map<string, ToolDefinition>;
  private parentPermissionMode: PermissionMode;
  private parentCwd: string;

  constructor(
    eventBus: EventBus,
    allTools: ToolDefinition[],
    parentPermissionMode: PermissionMode,
    parentCwd: string
  ) {
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
    const agentId = `${config.name}@default`;
    const startedAt = Date.now();

    try {
      // Derive child permissions
      const childPermissionMode = deriveChildPermissions(
        this.parentPermissionMode,
        config.permissions
      );

      // Build allowed tool list
      const parentTools = Array.from(this.allTools.keys()) as ToolName[];
      const allowedToolNames = buildChildToolAllowList(parentTools, {
        tools: config.tools,
        deniedTools: config.deniedTools,
      });

      // Filter tools
      const childTools = Array.from(this.allTools.values()).filter((tool) =>
        allowedToolNames.includes(tool.name as ToolName)
      );

      // Create abort controller
      const abortController = new AbortController();

      // Create runtime
      const runtime: SubAgentRuntime = {
        identity: {
          agentId,
          name: config.name,
          team: 'default',
          parentId: null,
        },
        status: 'spawning',
        config,
        queryEngine: null, // Will be set below
        abortController,
        startedAt,
        completedAt: undefined,
        toolUseCount: 0,
        totalTokensUsed: 0,
      };

      // Store runtime
      this.activeAgents.set(agentId, runtime);

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
      // Note: We need to dynamically import to avoid circular dependency
      const { QueryEngine } = await import('../../query/QueryEngine');

      const queryEngine = new QueryEngine(
        {
          model: config.model || 'claude-sonnet-4-20250514',
          provider: 'anthropic',
          maxTurns: config.maxTurns || 15,
          maxBudgetUsd: null,
          systemPrompt: config.systemPrompt,
        },
        childTools
      );

      runtime.queryEngine = queryEngine;

      // Start agent loop asynchronously
      this.runAgentLoop(runtime, parentContext, queryEngine).catch((error) => {
        console.error(`Agent ${agentId} loop error:`, error);
        runtime.status = 'failed';
        runtime.error = error;
        runtime.completedAt = Date.now();

        this.eventBus.emit(agentId, {
          type: 'agent:subagent_failed',
          agentId,
          error: error.message || String(error),
          timestamp: Date.now(),
        });
      });

      // Wire up abort controller to query engine
      abortController.signal.addEventListener('abort', () => {
        queryEngine.abort('Sub-agent timeout or cancellation requested');
      }, { once: true });

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
    parentContext: ToolUseContext,
    queryEngine: any
  ): Promise<void> {
    const { config, abortController } = runtime;
    const agentId = runtime.identity.agentId;

    // Wrap in AsyncLocalStorage for context isolation
    await agentContextStore.run(runtime, async () => {
      try {
        // Set up timeout
        const timeoutMs = (config.timeoutSeconds || 300) * 1000;
        const timeoutId = setTimeout(() => {
          abortController.abort();
        }, timeoutMs);

        // Submit message and collect events
        const eventGenerator = queryEngine.submitMessage(config.prompt);

        let lastAssistantMessage = '';
        let hasToolCalls = false;

        for await (const event of eventGenerator) {
          // Check if aborted
          if (abortController.signal.aborted) {
            break;
          }

          // Forward event to parent via EventBus
          this.eventBus.emit(agentId, event);

          // Collect final message
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
            runtime.totalTokensUsed += event.result?.metadata?.tokensUsed || 0;
          }
        }

        clearTimeout(timeoutId);

        // Determine completion status
        const isTimedOut = abortController.signal.aborted;
        const duration = Date.now() - runtime.startedAt;

        if (isTimedOut) {
          runtime.status = 'timed_out';
          this.eventBus.emit(agentId, {
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
          };

          this.eventBus.emit(agentId, {
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

        this.eventBus.emit(agentId, {
          type: 'agent:subagent_failed',
          agentId,
          error: runtime.error.message,
          timestamp: Date.now(),
        });
      }
    });
  }

  /**
   * Send a message to a sub-agent
   */
  async sendMessage(agentId: string, message: SubAgentMessage): Promise<void> {
    const runtime = this.activeAgents.get(agentId);
    if (!runtime) {
      throw new Error(`Agent ${agentId} not found`);
    }

    // For now, just log the message
    // In full implementation, this would add to agent's message queue
    console.log(`Message to ${agentId}:`, message);
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

      this.eventBus.emit(agentId, {
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

  /**
   * Get status of a sub-agent
   */
  getStatus(agentId: string): SubAgentStatus | null {
    const runtime = this.activeAgents.get(agentId);
    return runtime?.status || null;
  }

  /**
   * List all active agent IDs
   */
  listActive(): string[] {
    return Array.from(this.activeAgents.keys());
  }

  /**
   * Shutdown all sub-agents
   */
  async shutdownAll(): Promise<void> {
    const agentIds = this.listActive();
    await Promise.all(agentIds.map((id) => this.shutdown(id, true)));
  }
}
