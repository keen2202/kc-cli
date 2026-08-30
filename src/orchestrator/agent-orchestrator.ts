import { logger } from '../services/logger';
// Agent Orchestrator - Central coordinator for multi-agent system

import type {
  SubAgentSpawnConfig,
  SubAgentResult,
  AggregatedResult,
  SubAgentStatus,
} from './types.js';
import type { AgentEvent } from '../state/types.js';
import type { MultiAgentEvent } from '../state/events.js';
import type { ToolUseContext, ToolDefinition, ToolName } from '../tools/protocol.js';
import type { PermissionMode } from '../permissions/protocol.js';
import { Semaphore } from '../utils/semaphore.js';
import { EventBus, type EvolutionEvent } from './event-bus.js';
import { InProcessBackend } from './backends/in-process.js';
import { ResultAggregator } from './result-aggregator.js';
import { deriveChildPermissions } from './permission-cascader.js';
import { getState } from '../bootstrap/state.js';

/**
 * How long `spawn()` will wait for a permit before failing.
 *
 * Without a bound, a backend that never emits a terminal event leaks its permit
 * and the orchestrator deadlocks permanently once `maxConcurrentAgents` agents
 * have been spawned.
 */
const SPAWN_PERMIT_TIMEOUT_MS = 30_000;

/** Events that mean a sub-agent has reached a terminal state. */
const TERMINAL_EVENT_TYPES: ReadonlySet<string> = new Set([
  'agent:subagent_completed',
  'agent:subagent_failed',
  'agent:subagent_timed_out',
  'agent:subagent_cancelled',
]);

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
  private semaphore: Semaphore;
  /**
   * Idempotent permit-release hook per agent. Held here so paths outside
   * `spawn()` (wait timeouts, explicit cancel) can release a permit that the
   * terminal-event listener never saw.
   */
  private releaseHooks = new Map<string, (reason: string) => void>();

  constructor(allTools: ToolDefinition[], maxConcurrentAgents: number = 8) {
    this.semaphore = new Semaphore(maxConcurrentAgents, SPAWN_PERMIT_TIMEOUT_MS);
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
    // Acquire semaphore permit — bounds concurrent sub-agents. Times out so a
    // leaked permit degrades into a diagnosable error instead of a deadlock.
    await this.semaphore.acquire();

    // `agentId` is only known once the backend has spawned, but the
    // spawn-failure path also has to release — hence the placeholder.
    let agentId = '<not-spawned>';
    let released = false;

    /**
     * Release the permit at most once, whatever the reason. The previous code
     * declared `released` but never set it, so a terminal event followed by a
     * failing `register()` handed the semaphore back twice and inflated the
     * permit count past `maxConcurrentAgents`.
     */
    const releaseOnce = (reason: string): void => {
      if (released) return;
      released = true;
      this.releaseHooks.delete(agentId);
      this.semaphore.release();
      logger.orchestrator.debug('[AgentOrchestrator] released spawn permit', {
        agentId,
        reason,
      });
    };

    // Spawn via backend first — backend assigns the unique agentId
    const spawnResult = await this.backend.spawn(config, parentContext);

    if (!spawnResult.success) {
      releaseOnce('spawn-failed');
      throw new Error(`Failed to spawn agent: ${spawnResult.error}`);
    }

    agentId = spawnResult.agentId;
    this.releaseHooks.set(agentId, releaseOnce);

    // Register listener to release permit when agent reaches terminal state
    const unsubscribe = this.eventBus.on(agentId, (event: AgentEvent | MultiAgentEvent) => {
      if (!TERMINAL_EVENT_TYPES.has(event.type)) return;
      releaseOnce(event.type.replace('agent:subagent_', ''));
      unsubscribe();
    });

    try {
      // Register with aggregator
      this.aggregator.register(agentId, config);

      return agentId;
    } catch (error) {
      releaseOnce('register-failed');
      unsubscribe();
      throw error;
    }
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
        // The caller gave up on this agent: if the backend never emits a
        // terminal event, its permit would be held forever.
        this.releaseHooks.get(agentId)?.('wait-completion-timeout');
        reject(
          new Error(
            `Agent ${agentId} timed out after ${timeoutMs / 1000}s`
          )
        );
      }, timeoutMs);

      // Listen for completion
      const unsubscribe = this.eventBus.on(agentId, (event: AgentEvent | MultiAgentEvent) => {
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
    // If already done, return immediately
    if (this.aggregator.isAllDone()) {
      return this.aggregator.generateSummary();
    }

    // Event-based wait instead of polling: resolve when all agents complete
    await new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        unsubscribe();
        // Cancel any remaining agents
        const activeAgents = this.backend.listActive();
        const elapsed = timeoutMs / 1000;
        for (const agentId of activeAgents) {
          this.aggregator.recordTimeout(agentId, elapsed);
          this.releaseHooks.get(agentId)?.('wait-all-timeout');
          this.backend.shutdown(agentId, true).catch(err => { logger.orchestrator.error('[AgentOrchestrator] Failed to shutdown agent', err); });
        }
        resolve(); // Continue to get results (with timeouts recorded)
      }, timeoutMs);

      const unsubscribe = this.eventBus.onAny(() => {
        if (this.aggregator.isAllDone()) {
          clearTimeout(timeoutId);
          unsubscribe();
          resolve();
        }
      });

      // Double-check in case agents completed between our initial check and subscription
      if (this.aggregator.isAllDone()) {
        clearTimeout(timeoutId);
        unsubscribe();
        resolve();
      }
    });

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
    // A cancelled backend may never emit a terminal event of its own.
    this.releaseHooks.get(agentId)?.('cancelled');
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
   * Get the number of currently active (running) sub-agents.
   */
  activeCount(): number {
    return this.backend.listActive().length;
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
    this.releaseHooks.clear();
  }

  /**
   * Permits currently free, exposed for diagnostics and tests. A value above
   * `maxConcurrentAgents` means a permit was released more than once.
   */
  get availablePermits(): number {
    return this.semaphore.available;
  }

  // ─── AGP Evolution Coordination ─────────────────────────────────────────

  /**
   * Notify all sub-agents about an evolution event.
   * Used to coordinate resource updates across the multi-agent system.
   */
  broadcastEvolution(event: Omit<EvolutionEvent, 'timestamp'>): void {
    this.eventBus.emitEvolution({
      ...event,
      timestamp: Date.now(),
    });
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
