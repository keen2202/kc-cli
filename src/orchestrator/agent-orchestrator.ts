import { logger } from '../services/logger';
// Agent Orchestrator - Central coordinator for multi-agent system

import type {
  SubAgentSpawnConfig,
  SubAgentResult,
  AggregatedResult,
  SubAgentStatus,
  ReportFinding,
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
import { buildReportFollowUpMessage, validateReport } from './report-validator.js';
import { appendReportingObligations } from './agent-definitions.js';

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

interface TrackedCompletion {
  config: SubAgentSpawnConfig;
  promise: Promise<SubAgentResult>;
  resolve: (result: SubAgentResult) => void;
  reject: (error: Error) => void;
  followUpsUsed: number;
  settled: boolean;
  processing: boolean;
  /** True when waitForCompletion gave up on this agent. */
  abandoned: boolean;
  /** Completion event that raced a report-gate turn. */
  pendingCompletion?: SubAgentResult;
  /** Detach this agent's tracker listener once the promise settles. */
  unsubscribe?: () => void;
}

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
  /** Event-bus detach handles for terminal-event permit listeners. */
  private releaseUnsubscribes = new Map<string, () => void>();
  /** Completion promises tracked for report validation and waitForAll. */
  private trackedCompletions = new Map<string, TrackedCompletion>();
  /** Wakens waitForAll when the aggregator may have reached all-done. */
  private aggregateWaiters = new Set<() => void>();

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
    // RI-SPEC T05: every sub-agent gets the dedicated reporting-obligations
    // section, including generic (non-built-in) agents. Built-in configs are
    // already normalized by createAgentConfig, so the helper is idempotent.
    config = {
      ...config,
      systemPrompt: appendReportingObligations(config.systemPrompt),
    };

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
      this.releaseUnsubscribes.get(agentId)?.();
      this.releaseUnsubscribes.delete(agentId);
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

    // Register listener to release permit when agent reaches terminal state.
    // Gated agents keep the permit across report follow-up turns; the tracker
    // releases it once the report is finally settled (accepted or unresolved).
    const unsubscribe = this.eventBus.on(agentId, (event: AgentEvent | MultiAgentEvent) => {
      if (!TERMINAL_EVENT_TYPES.has(event.type)) return;
      const tracked = this.trackedCompletions.get(agentId);
      const gated = Boolean(tracked?.config.reportPolicy) ||
        (Array.isArray(tracked?.config.checkpoints) && tracked!.config.checkpoints!.length > 0);
      if (event.type === 'agent:subagent_completed' && gated) {
        return;
      }
      releaseOnce(event.type.replace('agent:subagent_', ''));
      unsubscribe();
    });
    this.releaseUnsubscribes.set(agentId, unsubscribe);

    try {
      // Register with aggregator
      this.aggregator.register(agentId, config);
      this.trackCompletion(agentId, config);

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
    const tracked = this.trackedCompletions.get(agentId);
    if (tracked) {
      return this.waitForTrackedCompletion(agentId, tracked, timeoutMs);
    }
    return this.waitForUntrackedCompletion(agentId, timeoutMs);
  }

  /**
   * Register a completion promise for a spawned agent. The event listener is
   * the single place where report validation, follow-up, aggregator recording
   * and `waitForAll` wakeups happen, regardless of whether the caller uses
   * `waitForCompletion` or `waitForAll`.
   */
  private trackCompletion(agentId: string, config: SubAgentSpawnConfig): void {
    let resolve!: (result: SubAgentResult) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<SubAgentResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // There may be no waitForCompletion caller (e.g. waitForAll only or a
    // background agent). A rejection handler keeps Node from treating that as
    // an unhandled rejection while still allowing later waiters to observe it.
    void promise.catch(() => {});

    const tracked: TrackedCompletion = {
      config,
      promise,
      resolve,
      reject,
      followUpsUsed: 0,
      settled: false,
      processing: false,
      abandoned: false,
    };
    this.trackedCompletions.set(agentId, tracked);

    tracked.unsubscribe = this.eventBus.on(agentId, (event: AgentEvent | MultiAgentEvent) => {
      if (event.type === 'agent:subagent_completed') {
        void this.handleTrackedCompletion(agentId, event.result);
      } else if (event.type === 'agent:subagent_failed') {
        this.settleTrackedError(
          agentId,
          new Error(`Agent ${agentId} failed: ${event.error}`),
          () => this.aggregator.recordFailure(agentId, event.error),
        );
      } else if (event.type === 'agent:subagent_timed_out') {
        this.settleTrackedError(
          agentId,
          new Error(`Agent ${agentId} timed out after ${event.elapsed}s`),
          () => this.aggregator.recordTimeout(agentId, event.elapsed),
        );
      } else if (event.type === 'agent:subagent_cancelled') {
        this.settleTrackedError(
          agentId,
          new Error(`Agent ${agentId} was cancelled`),
          () => this.aggregator.recordCancellation(agentId),
        );
      }
    });
  }

  /** Validate a completed report and either resume or settle the agent. */
  private async handleTrackedCompletion(
    agentId: string,
    result: SubAgentResult,
  ): Promise<void> {
    const tracked = this.trackedCompletions.get(agentId);
    if (!tracked || tracked.settled || tracked.abandoned) return;
    if (!result || typeof result !== 'object') return;
    if (tracked.processing) {
      // The resumed agent can complete before the previous handler's await
      // unwinds; queue it instead of dropping a terminal event.
      tracked.pendingCompletion = result;
      return;
    }

    tracked.processing = true;
    try {
      const outcome = await this.applyReportGate(agentId, tracked, result);
      if (outcome.kind === 'followup') {
        return;
      }

      tracked.settled = true;
      tracked.unsubscribe?.();
      this.aggregator.recordResult(outcome.result);
      this.notifyAggregateWaiters();
      this.releaseReportContext(agentId);
      this.releaseHooks.get(agentId)?.('report-gate-final');
      tracked.resolve(outcome.result);
    } catch (error) {
      tracked.settled = true;
      tracked.unsubscribe?.();
      const message = error instanceof Error ? error.message : String(error);
      this.aggregator.recordFailure(agentId, `report gate error: ${message}`);
      this.notifyAggregateWaiters();
      this.releaseReportContext(agentId);
      this.releaseHooks.get(agentId)?.('report-gate-error');
      tracked.reject(new Error(`Agent ${agentId} report validation failed: ${message}`));
    } finally {
      tracked.processing = false;
      const pending = tracked.pendingCompletion;
      tracked.pendingCompletion = undefined;
      if (pending && !tracked.settled && !tracked.abandoned) {
        void this.handleTrackedCompletion(agentId, pending);
      }
    }
  }

  /**
   * Run R1–R5 and, when blockers remain inside budget, ask the same sub-agent
   * to resume with one follow-up turn.
   */
  private async applyReportGate(
    agentId: string,
    tracked: TrackedCompletion,
    result: SubAgentResult,
  ): Promise<{ kind: 'final'; result: SubAgentResult } | { kind: 'followup' }> {
    const config = tracked.config;
    const checkpoints = Array.isArray(config.checkpoints) ? config.checkpoints : [];
    const policy = config.reportPolicy;
    const gated = Boolean(policy) || checkpoints.length > 0;
    if (!gated) {
      return { kind: 'final', result };
    }

    const requiredSections = Array.isArray(policy?.requiredSections)
      ? policy!.requiredSections
      : checkpoints.length > 0
        ? ['检查站作答']
        : [];
    const findings = validateReport(result, {
      requiredSections,
      checkpoints,
    });

    const blockers = findings.filter((f) => f.severity === 'blocker');
    const maxFollowUps = Math.max(0, Math.min(2, policy?.maxFollowUps ?? 1));

    if (blockers.length > 0 && tracked.followUpsUsed < maxFollowUps) {
      tracked.followUpsUsed++;
      const followUpMessage = buildReportFollowUpMessage(findings, { checkpoints });
      const resumed = await this.resumeAgent(agentId, followUpMessage);
      if (!resumed) {
        // A synthetic/manual completion event has no live backend to resume.
        // Keep waiting: the next completion event (if any) is validated too.
        logger.orchestrator.debug(
          '[AgentOrchestrator] follow-up requested but backend cannot resume',
          { agentId },
        );
      }
      return { kind: 'followup' };
    }

    return { kind: 'final', result: this.attachFindings(result, findings, tracked, blockers.length > 0) };
  }

  /** Attach findings/resolution metadata without mutating the input result. */
  private attachFindings(
    result: SubAgentResult,
    findings: ReportFinding[],
    tracked: TrackedCompletion,
    unresolved: boolean,
  ): SubAgentResult {
    if (findings.length === 0 && !unresolved) return result;
    const meta = {
      ...(result.meta ?? {}),
      reportFindings: findings,
      followUpsUsed: tracked.followUpsUsed,
      ...(unresolved ? { unresolved: true } : {}),
    };
    return {
      ...result,
      ...(unresolved
        ? {
            success: false,
            error:
              result.error ??
              `Report integrity unresolved: ${findings
                .filter((f) => f.severity === 'blocker')
                .map((f) => f.code)
                .join(', ')}`,
          }
        : {}),
      meta,
    };
  }

  private settleTrackedError(agentId: string, error: Error, record: () => void): void {
    const tracked = this.trackedCompletions.get(agentId);
    if (!tracked || tracked.settled || tracked.abandoned) return;
    tracked.settled = true;
    tracked.processing = false;
    tracked.unsubscribe?.();
    record();
    this.releaseReportContext(agentId);
    this.notifyAggregateWaiters();
    tracked.reject(error);
  }

  private waitForTrackedCompletion(
    agentId: string,
    tracked: TrackedCompletion,
    timeoutMs: number,
  ): Promise<SubAgentResult> {
    return new Promise((resolve, reject) => {
      let done = false;
      const timeoutId = setTimeout(() => {
        if (done) return;
        done = true;
        tracked.abandoned = true;
        tracked.unsubscribe?.();
        this.aggregator.recordTimeout(agentId, timeoutMs / 1000);
        this.releaseReportContext(agentId);
        this.notifyAggregateWaiters();
        // The caller gave up on this agent: if the backend never emits a
        // terminal event, its permit would be held forever.
        this.releaseHooks.get(agentId)?.('wait-completion-timeout');
        reject(new Error(`Agent ${agentId} timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);

      tracked.promise.then(
        (result) => {
          if (done) return;
          done = true;
          clearTimeout(timeoutId);
          resolve(result);
        },
        (error) => {
          if (done) return;
          done = true;
          clearTimeout(timeoutId);
          reject(error);
        },
      );
    });
  }

  /**
   * Existing event-based path for manually-emitted events on unregistered
   * agent IDs (kept exactly as before to preserve the public contract).
   */
  private waitForUntrackedCompletion(
    agentId: string,
    timeoutMs: number,
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

  /** Resume a completed sub-agent for one reporting follow-up turn. */
  private async resumeAgent(agentId: string, message: string): Promise<boolean> {
    const backend = this.backend as InProcessBackend & {
      resume?: (agentId: string, message: string) => Promise<boolean>;
    };
    if (typeof backend.resume === 'function') {
      try {
        return await backend.resume(agentId, message);
      } catch (error) {
        logger.orchestrator.warn('[AgentOrchestrator] report follow-up resume failed', {
          agentId,
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    }
    // Generic backend fallback: queue a user message as a best effort.
    try {
      await this.backend.sendMessage(agentId, {
        type: 'user_message',
        from: 'parent',
        payload: { message, reportFollowUp: true },
      });
      return true;
    } catch {
      return false;
    }
  }

  private notifyAggregateWaiters(): void {
    for (const waiter of Array.from(this.aggregateWaiters)) {
      waiter();
    }
  }

  private releaseReportContext(agentId: string): void {
    const backend = this.backend as InProcessBackend & {
      releaseReportContext?: (id: string) => void;
    };
    backend.releaseReportContext?.(agentId);
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

    // Event-based wait instead of polling: resolve when all agents complete.
    // `aggregateWaiters` covers asynchronous report-gate settlement, which
    // happens after the terminal event and therefore not inside onAny.
    await new Promise<void>((resolve) => {
      let settled = false;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      let unsubscribe: () => void = () => {};
      const onChanged = (): void => {
        if (!settled && this.aggregator.isAllDone()) {
          finish();
        }
      };
      const finish = (): void => {
        if (settled) return;
        settled = true;
        if (timeoutId) clearTimeout(timeoutId);
        unsubscribe();
        this.aggregateWaiters.delete(onChanged);
        resolve();
      };

      this.aggregateWaiters.add(onChanged);

      timeoutId = setTimeout(() => {
        // Cancel any remaining agents
        const activeAgents = this.backend.listActive();
        const elapsed = timeoutMs / 1000;
        for (const agentId of activeAgents) {
          this.aggregator.recordTimeout(agentId, elapsed);
          this.releaseHooks.get(agentId)?.('wait-all-timeout');
          this.backend.shutdown(agentId, true).catch(err => { logger.orchestrator.error('[AgentOrchestrator] Failed to shutdown agent', err); });
        }
        finish(); // Continue to get results (with timeouts recorded)
      }, timeoutMs);

      unsubscribe = this.eventBus.onAny(onChanged);

      // Double-check in case agents completed between our initial check and subscription
      if (this.aggregator.isAllDone()) {
        finish();
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
    this.notifyAggregateWaiters();
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
    this.releaseUnsubscribes.clear();
    this.trackedCompletions.clear();
    this.aggregateWaiters.clear();
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
