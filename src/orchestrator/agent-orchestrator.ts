// Agent Orchestrator - Central coordinator for multi-agent system

import type {
  SubAgentSpawnConfig,
  SubAgentResult,
  AggregatedResult,
  SubAgentStatus,
} from './types.js';
import type { ToolUseContext, ToolDefinition, ToolName } from '../types/tools.js';
import type { PermissionMode } from '../types/permissions.js';
import { EventBus } from './event-bus.js';
import { InProcessBackend } from './backends/in-process.js';
import { ResultAggregator } from './result-aggregator.js';
import { deriveChildPermissions } from './permission-cascader.js';
import { getState } from '../bootstrap/state.js';

/**
 * AgentOrchestrator - Manages sub-agent lifecycle
 *
 * Coordinates spawning, monitoring, and collecting results from multiple sub-agents.
 */
export class AgentOrchestrator {
  private eventBus: EventBus;
  private backend: InProcessBackend;
  private aggregator: ResultAggregator;
  private allTools: ToolDefinition[];
  private parentPermissionMode: PermissionMode;

  constructor(allTools: ToolDefinition[]) {
    this.eventBus = new EventBus();
    this.allTools = allTools;
    this.parentPermissionMode = getState().permissionMode;
    this.aggregator = new ResultAggregator();
    this.backend = new InProcessBackend(
      this.eventBus,
      allTools,
      this.parentPermissionMode,
      getState().cwd
    );
  }

  /**
   * Spawn a single sub-agent and wait for completion
   *
   * @param config - Spawn configuration
   * @param parentContext - Parent's tool use context
   * @returns agentId for tracking
   */
  async spawn(
    config: SubAgentSpawnConfig,
    parentContext: ToolUseContext
  ): Promise<string> {
    const agentId = `${config.name}@default`;

    // Register with aggregator
    this.aggregator.register(agentId, config);

    // Spawn via backend
    const spawnResult = await this.backend.spawn(config, parentContext);

    if (!spawnResult.success) {
      this.aggregator.recordFailure(agentId, spawnResult.error || 'Spawn failed');
      throw new Error(`Failed to spawn agent ${agentId}: ${spawnResult.error}`);
    }

    return agentId;
  }

  /**
   * Spawn multiple sub-agents in batch
   *
   * @param configs - Array of spawn configurations
   * @param parentContext - Parent's tool use context
   * @returns Array of agentIds
   */
  async spawnBatch(
    configs: SubAgentSpawnConfig[],
    parentContext: ToolUseContext
  ): Promise<string[]> {
    const agentIds: string[] = [];

    // Spawn all agents
    for (const config of configs) {
      try {
        const agentId = await this.spawn(config, parentContext);
        agentIds.push(agentId);
      } catch (error) {
        console.error(`Failed to spawn ${config.name}:`, error);
        // Continue with other agents
      }
    }

    return agentIds;
  }

  /**
   * Wait for a specific sub-agent to complete
   *
   * @param agentId - Agent ID to wait for
   * @param timeoutMs - Timeout in milliseconds (default: 5 minutes)
   * @returns Sub-agent result
   */
  async waitForCompletion(
    agentId: string,
    timeoutMs: number = 300000
  ): Promise<SubAgentResult> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.aggregator.recordTimeout(agentId, timeoutMs / 1000);
        reject(
          new Error(
            `Agent ${agentId} timed out after ${timeoutMs / 1000}s`
          )
        );
      }, timeoutMs);

      // Listen for completion
      const unsubscribe = this.eventBus.on(agentId, (event: any) => {
        if (event.type === 'agent:subagent_completed') {
          clearTimeout(timeoutId);
          unsubscribe();
          resolve(event.result);
        } else if (event.type === 'agent:subagent_failed') {
          clearTimeout(timeoutId);
          unsubscribe();
          this.aggregator.recordFailure(agentId, event.error);
          reject(new Error(`Agent ${agentId} failed: ${event.error}`));
        } else if (event.type === 'agent:subagent_timed_out') {
          clearTimeout(timeoutId);
          unsubscribe();
          this.aggregator.recordTimeout(agentId, event.elapsed);
          reject(
            new Error(
              `Agent ${agentId} timed out after ${event.elapsed}s`
            )
          );
        } else if (event.type === 'agent:subagent_cancelled') {
          clearTimeout(timeoutId);
          unsubscribe();
          this.aggregator.recordCancellation(agentId);
          reject(new Error(`Agent ${agentId} was cancelled`));
        }
      });
    });
  }

  /**
   * Wait for all spawned agents to complete
   *
   * @param timeoutMs - Overall timeout in milliseconds
   * @returns Aggregated result from all agents
   */
  async waitForAll(timeoutMs: number = 600000): Promise<AggregatedResult> {
    const startTime = Date.now();

    // Poll until all agents are done or timeout
    while (!this.aggregator.isAllDone()) {
      if (Date.now() - startTime > timeoutMs) {
        // Cancel any remaining agents
        const activeAgents = this.backend.listActive();
        for (const agentId of activeAgents) {
          this.aggregator.recordTimeout(
            agentId,
            (Date.now() - startTime) / 1000
          );
          await this.backend.shutdown(agentId, true);
        }
        break;
      }

      // Wait a bit before polling again
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    return this.aggregator.generateSummary();
  }

  /**
   * Send a message to a running sub-agent
   *
   * @param agentId - Target agent ID
   * @param message - Message text
   */
  async sendMessage(agentId: string, message: string): Promise<void> {
    await this.backend.sendMessage(agentId, {
      type: 'user_message',
      from: 'parent',
      payload: { message },
    });
  }

  /**
   * Cancel a running sub-agent
   *
   * @param agentId - Agent ID to cancel
   */
  async cancel(agentId: string): Promise<void> {
    await this.backend.shutdown(agentId, true);
    this.aggregator.recordCancellation(agentId);
  }

  /**
   * Get status of a sub-agent
   *
   * @param agentId - Agent ID
   * @returns Current status or null if not found
   */
  getStatus(agentId: string): SubAgentStatus | null {
    return this.backend.getStatus(agentId);
  }

  /**
   * List all agents with their status
   */
  listAgents(): Array<{
    agentId: string;
    name: string;
    status: SubAgentStatus;
  }> {
    const agentIds = this.backend.listActive();
    return agentIds.map((id) => ({
      agentId: id,
      name: id.split('@')[0] || id,
      status: this.backend.getStatus(id) || 'unknown' as SubAgentStatus,
    }));
  }

  /**
   * Get event bus for subscribing to agent events
   */
  getEventBus(): EventBus {
    return this.eventBus;
  }

  /**
   * Get result aggregator
   */
  getAggregator(): ResultAggregator {
    return this.aggregator;
  }

  /**
   * Shutdown all sub-agents and clean up
   *
   * @param force - If true, immediately abort all agents
   */
  async shutdownAll(force = false): Promise<void> {
    await this.backend.shutdownAll();
    this.eventBus.clear();
  }
}

/**
 * Global orchestrator singleton
 */
let globalOrchestrator: AgentOrchestrator | null = null;

/**
 * Get or create the global orchestrator
 */
export function getOrchestrator(tools?: ToolDefinition[]): AgentOrchestrator {
  if (!globalOrchestrator) {
    if (!tools) {
      throw new Error(
        'Tools must be provided to initialize the global orchestrator'
      );
    }
    globalOrchestrator = new AgentOrchestrator(tools);
  }
  return globalOrchestrator;
}

/**
 * Reset the global orchestrator (for testing)
 */
export function resetOrchestrator(): void {
  globalOrchestrator?.shutdownAll(true);
  globalOrchestrator = null;
}
