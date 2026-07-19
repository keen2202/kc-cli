import { logger } from '../services/logger';
// Query Engine - Refactored with state machine pattern
// Inspired by OpenHarness's query loop architecture
// Sub-modules (ConversationState, CompactionHandler, MemoryHandler, ErrorHandler)
// handle specific phases to keep QueryEngine as a facade.

import type { ChatMessage, StreamEvent, AssistantMessage, ToolCall, ToolResult } from '../query/protocol';
import type { ToolDefinition, ToolUseContext } from '../tools/protocol';
import { AgentStateMachine } from '../state/machine';
import { ObservableStateStore, createInitialState } from '../state/store';
import { ToolExecutor } from '../executors/toolExecutor';
import type { AgentEvent } from '../state/types';
import { hasPermissionsToUseTool, buildPermissionContext } from '../permissions/engine';
import { getState } from '../bootstrap/state';
import { createAPIClient, LLMProvider } from '../api';
import type { BaseApiClient, LLMStreamEvent as APIStreamEvent, LLMRequestConfig } from '../api';
import { UserProfileService } from '../services/userProfile';
import { getSystemPromptAdaptation } from '../services/behavioralAdapter';
import { PromptCacheMetrics } from '../services/promptCacheMetrics';
import { CachePrefixService, buildCacheStrategy } from '../services/cachePrefix';
import { estimateTaskComplexity } from '../api/prompts/task-prompts';
import { autoStageFile, autoCommitAll } from '../utils/git';
import { KCError } from '../utils/errors';
import { validateApiKey } from '../utils/api-key';
import { spawn } from 'child_process';

// Sub-modules
import { ConversationState } from './QueryEngineState';
import { CompactionHandler } from './QueryEngineCompaction';
import { MemoryHandler } from './QueryEngineMemory';
import { ErrorHandler } from './QueryEngineError';
import { estimateMessageTokensArray } from '../utils/tokenEstimation';

import { PlanningPhaseHandler } from './QueryEnginePlanning';

import { v4 as uuidv4 } from 'uuid';

import { FileContentCache } from '../services/cache/FileContentCache';
import { ImportanceTagger } from './QueryEngineImportance';
import type { TurnTag, ContextEfficiencyConfig, PlanningPhaseConfig, PatchGuaranteeConfig } from './protocol';

/**
 * Result of pre-exit test verification.
 */
type VerificationResult = {
  canExit: boolean;
  reason: 'tests_pass' | 'tests_fail' | 'tests_not_found' | 'timeout';
  failures?: string[];
  output?: string;
};

export interface QueryEngineConfig {
  model: string;
  provider: LLMProvider;
  apiKey?: string;
  apiBaseUrl?: string;
  maxTurns: number;
  maxBudgetUsd: number | null;
  systemPrompt?: string;
  contextWindow?: number;
  maxMessages?: number;
  memory?: import('../memory/integration').MemoryIntegrationConfig;
  permissionRules?: {
    deny?: string[];
    ask?: string[];
    allow?: string[];
  };
  /** AGP Evolution hook — called after query completion if evolution is enabled */
  evolution?: {
    enabled: boolean;
    onEvolve?: (sessionId: string) => Promise<void>;
  };
  /** Auto-extend turn budget when active progress is detected */
  autoExtendTurns?: boolean;
  /** Hard ceiling for auto-extended turns (default 100) */
  maxTurnsCeiling?: number;
  /** Minimum turns before agent is allowed to exit (prevents early abandonment) */
  minTurns?: number;
  /** Auto-commit interval in turns (0 = disabled, default 0) */
  autoCommitInterval?: number;

  /** Context window efficiency configuration (Area 3) */
  contextEfficiency?: ContextEfficiencyConfig;

  /** Strategic planning phase configuration (Area 1) */
  planningPhase?: PlanningPhaseConfig;

  /** Patch guarantee configuration (Area 2) */
  patchGuarantee?: PatchGuaranteeConfig;
}

/**
 * Query Engine with explicit state machine pattern.
 * Manages the full query lifecycle through distinct phases:
 * idle → compacting → streaming → deciding → executing → (loop or complete)
 *
 * Sub-modules handle specific concerns:
 * - ConversationState: message storage, token caching, trimming
 * - CompactionHandler: auto-compaction with micro/full/force strategies
 * - MemoryHandler: memory integration for context loading
 * - ErrorHandler: circuit breaker, retry, error classification
 */
export class QueryEngine {
  // State management
  private stateStore: ObservableStateStore;
  private stateMachine: AgentStateMachine;

  // LLM API Client
  private apiClient: BaseApiClient;

  // Sub-modules (dependency injection points)
  private conversation: ConversationState;
  private compaction: CompactionHandler;
  private memory: MemoryHandler;
  private errorHandler: ErrorHandler;

  // Services
  private toolExecutor: ToolExecutor;
  private userProfile: UserProfileService;
  private config: QueryEngineConfig;
  private abortController: AbortController;

  // Cache metrics tracking
  private cacheMetrics = new PromptCacheMetrics();

  // Cache prefix service for byte-stable prompt prefixes
  private cachePrefix: CachePrefixService;

  // Dual-queue steering system
  private steerQueue: ChatMessage[] = [];
  private followUpQueue: ChatMessage[] = [];
  private steeringEnabled = true;

  // File modification tracking (for incremental memory and patch guarantee)
  private modifiedFiles: Set<string> = new Set();
  private lastModifiedTurn: number = 0;

  // Area 3: Context efficiency components
  private fileContentCache: FileContentCache;
  private importanceTagger: ImportanceTagger;
  private readHistory = new Map<string, number>();
  private editHistory = new Map<string, number>();

  // Area 1: Planning phase handler
  private planningHandler: PlanningPhaseHandler;

  // Area 2: Patch Guarantee — zero-patch detection
  private zeroPatchRetries = 0;
  private verificationRetries = 0;

  constructor(config: QueryEngineConfig, tools: ToolDefinition[]) {
    this.config = config;
    this.abortController = new AbortController();

    // Initialize API client
    this.apiClient = createAPIClient({
      provider: config.provider,
      apiKey: config.apiKey || process.env.KC_API_KEY || '',
      baseUrl: config.apiBaseUrl,
      model: config.model,
    });

    // Initialize sub-modules
    this.conversation = new ConversationState({
      maxMessages: config.maxMessages,
    });
    this.compaction = new CompactionHandler();
    this.memory = new MemoryHandler(config.memory || {});
    this.errorHandler = new ErrorHandler();

    // Initialize state store
    this.stateStore = new ObservableStateStore(createInitialState({
      model: config.model,
      provider: config.provider,
      maxTurns: config.maxTurns,
      maxBudgetUsd: config.maxBudgetUsd,
    }));

    // Initialize state machine
    this.stateMachine = new AgentStateMachine(this.stateStore);

    // Initialize tool executor with permission config from user settings
    const rules = config.permissionRules || {};
    this.toolExecutor = new ToolExecutor(tools, getState().cwd, {
      alwaysDenyRules: rules.deny || [],
      alwaysAskRules: rules.ask || [],
      alwaysAllowRules: rules.allow || [],
    });

    // Initialize user profile (level-based adaptation)
    this.userProfile = new UserProfileService();

    // Initialize cache prefix service
    this.cachePrefix = new CachePrefixService(
      config.provider,
      buildCacheStrategy(config.provider),
    );

    // Initialize context efficiency components
    this.fileContentCache = new FileContentCache(
      config.contextEfficiency?.dedupCacheSize ?? 500
    );
    this.importanceTagger = new ImportanceTagger();

    // Initialize planning phase handler
    this.planningHandler = new PlanningPhaseHandler(config.planningPhase || {});

    // Link planning handler to tool executor for defense-in-depth filtering
    this.toolExecutor.setToolBlockCheck((toolName: string) => {
      if (this.planningHandler.isEnabled && !this.planningHandler.isToolAllowed(toolName)) {
        return this.planningHandler.getBlockedToolMessage(toolName);
      }
      return null;
    });
  }

  /** Get the current API key (for startup validation). */
  getApiKey(): string {
    return this.config.apiKey || '';
  }

  /**
   * Update the API key at runtime (e.g., from /key command).
   * Validates the key format and recreates the API client on success.
   * Returns an error message if validation fails, or null on success.
   */
  setApiKey(apiKey: string): string | null {
    const validation = validateApiKey(apiKey, this.config.provider);
    if (validation !== null) return validation;

    this.config.apiKey = apiKey;
    this.apiClient = createAPIClient({
      provider: this.config.provider,
      apiKey,
      baseUrl: this.config.apiBaseUrl,
      model: this.config.model,
    });
    return null;
  }

  /**
   * Main query entry point - uses state machine to manage lifecycle
   */
  async *submitMessage(userMessage: string): AsyncGenerator<StreamEvent | AgentEvent> {
    // Add user message
    const userMsg: ChatMessage = {
      id: uuidv4(),
      role: 'user',
      content: userMessage,
      timestamp: Date.now(),
    };
    this.conversation.addMessage(userMsg);

    // Enforce message limit to prevent unbounded memory growth
    const trimmed = this.conversation.trimIfNeeded();
    if (trimmed > 0) {
      logger.query.warn(`[QueryEngine] Message history exceeded limit, trimmed ${trimmed} messages`);
    }

    // State machine loop
    try {
      let turnCount = 0;
      let maxTurns = this.config.maxTurns;
      const maxTurnsCeiling = this.config.maxTurnsCeiling || 100;
      const autoExtend = this.config.autoExtendTurns || false;

      // Complexity-aware turn adjustment (only if no explicit CLI override)
      if (!getState().maxTurns) {
        const estimate = estimateTaskComplexity(userMessage);
        if (estimate.suggestedTurns > maxTurns) {
          const adjusted = Math.min(estimate.suggestedTurns, maxTurnsCeiling);
          logger.query.info(`[QueryEngine] Task complexity: ${estimate.complexity}, adjusting maxTurns ${maxTurns} → ${adjusted}`);
          maxTurns = adjusted;
        }
      }

      while (!this.stateMachine.isTerminal()) {
        // Check aborted at each turn start — yield error and stop
        if (this._aborted) {
          this.stateMachine.forceTransitionTo('error');
          yield { type: 'agent:error', error: new Error('Query aborted'), recoverable: false, timestamp: Date.now() } as AgentEvent;
          return;
        }

        const currentState = this.stateMachine.currentState;

        switch (currentState) {
          case 'planning': {
            // Inject planning system prompt on first planning turn
            if (this.planningHandler.currentTurn === 0) {
              this.conversation.addMessage({
                id: `planning_system_${Date.now()}`,
                role: 'system',
                content: this.planningHandler.getSystemPrompt(),
                timestamp: Date.now(),
              });
              yield {
                type: 'agent:planning_started',
                timestamp: Date.now(),
              } as AgentEvent;
            }

            // Run one streaming turn (read/search tools only)
            yield* this.streamingPhase();

            // Check if agent signaled completion
            const lastMsg = this.conversation.getLastMessage();
            const lastAssistantMsg = lastMsg && lastMsg.role === 'assistant'
              ? lastMsg as AssistantMessage
              : undefined;
            const isComplete = lastAssistantMsg
              ? this.planningHandler.evaluateComplete(lastAssistantMsg)
              : false;

            const hasMoreBudget = this.planningHandler.recordTurn();

            yield {
              type: 'agent:planning_turn',
              turn: this.planningHandler.currentTurn,
              timestamp: Date.now(),
            } as AgentEvent;

            if (isComplete || !hasMoreBudget) {
              // Extract findings from planning phase assistant messages
              const allMsgs = this.conversation.getMessages();
              const planMsgs: AssistantMessage[] = [];
              for (let i = allMsgs.length - 1; i >= 0 && planMsgs.length < this.planningHandler.currentTurn; i--) {
                if (allMsgs[i].role === 'assistant') {
                  planMsgs.unshift(allMsgs[i] as AssistantMessage);
                }
              }
              const findings = this.planningHandler.extractFindings(planMsgs);

              yield {
                type: 'agent:planning_complete',
                findings,
                timestamp: Date.now(),
              } as AgentEvent;

              // Add findings summary to conversation for the main phase
              if (findings.length > 0) {
                const summary = findings.map(f =>
                  `- Hypothesis: ${f.hypothesis}\n  Files: ${f.relevantFiles.join(', ')}\n  Confidence: ${f.confidence}`
                ).join('\n\n');
                this.conversation.addMessage({
                  id: `planning_findings_${Date.now()}`,
                  role: 'system',
                  content: `## Planning Phase Complete\n\nKey findings:\n\n${summary}\n\nYou may now edit files. Proceed with implementation.`,
                  timestamp: Date.now(),
                });
              }

              if (isComplete && !this.planningHandler.isExemptFromBudget) {
                turnCount += this.planningHandler.currentTurn;
              }

              this.stateMachine.transitionTo('streaming');
            }
            // else: continue planning loop (state stays 'planning')
            break;
          }

          case 'idle':
            if (this.planningHandler.isEnabled) {
              this.stateMachine.transitionTo('planning');
            } else {
              this.stateMachine.transitionTo('compacting');
            }
            break;

          case 'compacting':
            yield* this.compactingPhase();
            this.stateMachine.transitionTo('streaming');
            break;

          case 'streaming':
            // Apply any completed async compaction result before streaming.
            // This picks up the result of a fire-and-forget triggerFullCompactAsync()
            // call that finished during the previous executing / deciding phases.
            // We pass the current messages so that any messages added after the
            // compaction was triggered are preserved in the merge.
            const asyncCompactResult = this.compaction.drainPendingCompactResult(
              this.conversation.getMessages()
            );
            if (asyncCompactResult) {
              this.conversation.setMessages(asyncCompactResult.messages);
            }

            yield* this.streamingPhase();
            turnCount++;

            // Area 3: Context Efficiency — tag each turn for smart compaction
            if (this.config.contextEfficiency?.importanceTagging ?? true) {
              this.fileContentCache.setTurn(turnCount);
              const allMsgs = this.conversation.getMessages();
              let lastAssistantMsg: AssistantMessage | undefined;
              for (let i = allMsgs.length - 1; i >= 0; i--) {
                if (allMsgs[i].role === 'assistant') {
                  lastAssistantMsg = allMsgs[i] as AssistantMessage;
                  break;
                }
              }
              if (lastAssistantMsg) {
                // Collect tool names and outputs from this turn
                const toolNames = (lastAssistantMsg.toolCalls || []).map(tc => tc.toolName);
                const toolOutputs: string[] = [];
                // Scan recent tool messages for outputs
                for (let i = allMsgs.length - 1; i >= 0; i--) {
                  const m = allMsgs[i];
                  if (m.role === 'tool' && m.toolResults) {
                    for (const tr of m.toolResults) {
                      if (tr.output) toolOutputs.push(typeof tr.output === 'string' ? tr.output : String(tr.output));
                    }
                  }
                }

                const tag = this.importanceTagger.tagTurn(
                  lastAssistantMsg,
                  toolNames,
                  toolOutputs,
                  turnCount,
                  Array.from(this.modifiedFiles)
                );
                this.conversation.tagMessage(lastAssistantMsg.id, tag);

                // Track file read/edit history for duplicate detection
                for (const fp of tag.filePaths) {
                  if (toolNames.includes('write') || toolNames.includes('edit')) {
                    this.editHistory.set(fp, turnCount);
                    this.fileContentCache.invalidate(fp);
                  } else {
                    this.readHistory.set(fp, turnCount);
                  }
                }
              }
            }

            // Phase 1 reminder (first turn)
            if (turnCount === 1 && maxTurns > 10) {
              this.steer(`[Phase 1 - Planning] You are in the planning phase. Focus on reading files and understanding the codebase. Do not make changes yet. Formulate a concrete plan before proceeding to implementation.`);
            }

            // Phase 3 reminder (5 turns before budget exhaustion)
            if (turnCount === maxTurns - 5 && maxTurns > 10) {
              this.steer(`[Phase 3 - Verification] You are entering the verification phase. Stop making new changes. Run tests to verify your modifications, review all changed files, and fix any remaining issues.`);
            }

            // Periodic progress summary (every 10 turns)
            if (turnCount % 10 === 0 && turnCount > 0 && this.modifiedFiles.size > 0) {
              const fileList = Array.from(this.modifiedFiles).map(f => `- ${f}`).join('\n');
              const remaining = maxTurns - turnCount;
              this.conversation.addMessage({
                id: `checkpoint_${turnCount}_${Date.now()}`,
                role: 'user',
                content: `[Progress Checkpoint - Turn ${turnCount}/${maxTurns}]\nModified files so far:\n${fileList}\n\nRemember these modifications as you continue working. You have ${remaining} turns remaining.`,
                timestamp: Date.now(),
              });
            }

            // P0: Periodic auto-commit (every N turns when there are uncommitted changes)
            const autoCommitInterval = this.config.autoCommitInterval || 0;
            if (autoCommitInterval > 0 && turnCount > 0 && turnCount % autoCommitInterval === 0) {
              try {
                const committed = await autoCommitAll(getState().cwd);
                if (committed) {
                  logger.query.info(`[QueryEngine] Periodic auto-commit at turn ${turnCount}`);
                  yield this.createTextDeltaEvent(`[Auto-commit checkpoint at turn ${turnCount}]\n`);
                }
              } catch {
                // Non-fatal
              }
            }

            // P1: Anti-abandonment — inject encouragement when agent tries to exit too early
            const minTurns = this.config.minTurns || 0;
            if (minTurns > 0 && turnCount < minTurns) {
              // Check if agent is about to exit (no tool calls in last message)
              const lastMsg = this.conversation.getLastMessage();
              if (lastMsg && lastMsg.role === 'assistant' && (!(lastMsg as any).toolCalls || (lastMsg as any).toolCalls.length === 0)) {
                const remaining = minTurns - turnCount;
                this.steer(`[Anti-Abandonment] You have only completed ${turnCount} turns. You must continue working for at least ${remaining} more turns before you can stop. Keep exploring the codebase and making progress.`);
              }
            }

            if (turnCount >= maxTurns) {
              // Dynamic turn extension: if auto-extend enabled and agent is actively making progress
              if (autoExtend && maxTurns < maxTurnsCeiling && this.modifiedFiles.size > 0 && (turnCount - this.lastModifiedTurn) < 5) {
                maxTurns += 20;
                maxTurns = Math.min(maxTurns, maxTurnsCeiling);
                logger.query.info(`[QueryEngine] Extended turn budget to ${maxTurns} — active progress detected`);
                yield this.createTextDeltaEvent(`\n[Extended turn budget to ${maxTurns} — active progress detected]\n`);
              } else {
                logger.query.warn(`[QueryEngine] Max turns (${maxTurns}) reached, forcing completion`);
                yield this.createTextDeltaEvent(`\n[Reached maximum turn limit (${maxTurns}) — stopping]\n`);

                // Auto-commit on turn budget exhaustion (Phase 5.3)
                try {
                  const committed = await autoCommitAll(getState().cwd);
                  if (committed) {
                    logger.query.info('[QueryEngine] Auto-committed changes on turn limit');
                    yield this.createTextDeltaEvent(`[Auto-committed ${this.modifiedFiles.size} modified file(s)]\n`);
                  }
                } catch {
                  // Non-fatal
                }
              }
            }
            this.stateMachine.transitionTo('deciding');
            break;

          case 'deciding':
            const minTurnsEnforced = this.config.minTurns || 0;
            let hasTools: boolean;

            // FUN-13: Emit warning event on final turn instead of silently
            // setting hasTools=false (for better observability).
            if (turnCount >= maxTurns) {
              yield {
                type: 'agent:text_delta',
                text: '\n[Turn limit reached — completing]\n',
                timestamp: Date.now(),
              } as AgentEvent;
              hasTools = false;
            } else {
              hasTools = await this.decidingPhase(turnCount, minTurnsEnforced);
            }

            // Area 2: Zero-patch exhaustion error
            if (!hasTools && this.zeroPatchRetries > 0 && this.modifiedFiles.size === 0) {
              const maxRetries = this.config.patchGuarantee?.maxZeroPatchRetries ?? 3;
              if (this.zeroPatchRetries >= maxRetries) {
                const err = new KCError(
                  'model_no_patch',
                  'Agent exited without modifying any files after exhausting zero-patch retries',
                  { zeroPatchRetries: this.zeroPatchRetries }
                );
                yield {
                  type: 'agent:error',
                  error: err,
                  recoverable: false,
                  timestamp: Date.now(),
                } as AgentEvent;
              }
            }

            if (hasTools) {
              this.stateMachine.transitionTo('executing');
            } else {
              // Turn complete — drain followUpQueue before finishing
              const followUps = this.drainFollowUpQueue();
              if (followUps.length > 0) {
                for (const msg of followUps) {
                  this.conversation.addMessage(msg);
                }
                // Reset state machine to continue processing
                this.stateMachine.forceTransitionTo('streaming');
                break;
              }
              this.stateMachine.transitionTo('completed');
              // AGP Evolution hook: trigger self-evolution after completion
              if (this.config.evolution?.enabled && this.config.evolution.onEvolve) {
                try {
                  this.stateStore.set({
                    evolutionState: {
                      active: true,
                      iteration: 0,
                      committedChanges: 0,
                      rolledBackChanges: 0,
                    },
                  } as any);
                  this.stateMachine.transitionTo('evolving');
                  await this.config.evolution.onEvolve(this.stateStore.get().sessionId);
                  this.stateStore.set({
                    evolutionState: {
                      active: false,
                      iteration: 0,
                      lastEvolutionAt: Date.now(),
                      committedChanges: 0,
                      rolledBackChanges: 0,
                    },
                  } as any);
                } catch {
                  // Evolution failure is non-fatal
                }
                // Restore state machine back to completed after evolution
                this.stateMachine.transitionTo('completed');
              }
              yield this.createCompleteEvent();
            }
            break;

          case 'executing':
            yield* this.executingPhase();
            if (!this.stateMachine.isTerminal()) {
              // Drain steerQueue after execution before going back to streaming
              const steered = this.drainSteerQueue();
              if (steered.length > 0) {
                for (const msg of steered) {
                  this.conversation.addMessage(msg);
                  yield { type: 'agent:steered', message: msg, timestamp: Date.now() };
                }
              }
              this.stateMachine.transitionTo('streaming');
            }
            break;

          case 'completed':
          case 'error':
            return;

          default:
            throw new Error(`Unknown state: ${currentState}`);
        }
      }
    } catch (error) {
      this.stateMachine.forceTransitionTo('error');
      yield this.errorHandler.createErrorEvent(error);
    }
  }

  /**
   * Phase 1: Auto-compaction check
   * Delegates to CompactionHandler for the actual compaction logic.
   *
   * The LLM-based summarization path is fire-and-forget (async, non-blocking).
   * Compacted results are applied before the next streaming phase via the
   * drain check in the main state-machine loop.  Only the cheap synchronous
   * compaction steps (force truncation, microcompact) run inline here.
   */
  private async *compactingPhase(): AsyncGenerator<StreamEvent | AgentEvent> {
    const config = {
      contextWindow: this.config.contextWindow || 200_000,
      model: this.config.model,
      systemPrompt: this.config.systemPrompt,
      modifiedFiles: Array.from(this.modifiedFiles),
    };

    if (!this.compaction.shouldAttemptCompaction(this.conversation.getMessages(), config)) {
      return;
    }

    // Fire-and-forget: start compaction in the background.
    // The result will be picked up by drainPendingCompactResult() before the
    // next streaming phase (see the `case 'streaming':` branch in the loop).
    this.compaction.triggerFullCompactAsync(
      this.conversation.getMessages(),
      this.apiClient,
      config
    );
    // Return immediately — no LLM call is awaited.
  }

  /**
   * Phase 2: Stream response from LLM
   * Uses ErrorHandler for retry/circuit-breaker logic.
   * Uses MemoryHandler for context loading.
   */
  private async *streamingPhase(): AsyncGenerator<StreamEvent | AgentEvent> {
    const maxRetries = 10;

    // Cache tool definitions outside retry loop
    const toolsDef = this.toolExecutor.getRegisteredTools().map(toolName => {
      const tool = this.toolExecutor.getTool(toolName);
      return tool;
    }).filter((t): t is ToolDefinition => t !== undefined);

    // Load relevant memories via MemoryHandler
    const lastUserMsg = this.conversation.findLastUserMessage();
    let memoryContext = '';
    if (lastUserMsg && this.memory.isEnabled()) {
      const recentTools = toolsDef.slice(0, 5).map(t => t.name);
      memoryContext = await this.memory.loadRelevantMemories(
        lastUserMsg.content || '',
        recentTools
      );
    }

    // Build system prompt with stable/ephemeral separation for cache optimization
    const level = this.userProfile.getLevel();
    const levelAdaptation = getSystemPromptAdaptation(level, toolsDef);

    if (!this.cachePrefix.isFrozen()) {
      this.cachePrefix.freezePrefix(this.config.systemPrompt || '', toolsDef);
    }

    const stableSystemPrompt = this.cachePrefix.getStableSystemPrompt();
    const ephemeral = this.cachePrefix.getEphemeralAugmentations(memoryContext, levelAdaptation);
    const ephemeralContent = ephemeral
      ? [ephemeral.levelAdaptation, ephemeral.memoryContext].filter(Boolean).join('\n\n')
      : undefined;

    for (let retryAttempt = 0; retryAttempt <= maxRetries; retryAttempt++) {
      // If aborted, break to error state instead of continuing
      if (this._aborted) {
        throw new Error('Query aborted during streaming');
      }
      const apiMessages = this.buildApiMessages();

      const requestConfig: LLMRequestConfig = {
        model: this.config.model,
        messages: apiMessages,
        tools: toolsDef,
        systemPrompt: stableSystemPrompt,
        ephemeralContent,
        abortSignal: this.abortController.signal,
      };

      try {
        yield* this.streamLLMResponse(requestConfig, toolsDef);
        this.errorHandler.recordApiSuccess();
        return;
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));

        // Check if retry is possible
        const retryInfo = this.errorHandler.shouldRetry(err, retryAttempt);
        if (retryInfo) {
          logger.query.warn(`Streaming retry ${retryAttempt + 1}/${maxRetries} after ${retryInfo.delay}ms: ${err.message}`);
          yield { type: 'agent:error', error: err, recoverable: true, timestamp: Date.now() };
          await new Promise(resolve => setTimeout(resolve, retryInfo.delay));
          continue;
        }

        // Non-retryable - check if degraded (non-fatal)
        if (this.errorHandler.isDegradedError(err)) {
          logger.query.warn(`Degraded error in streaming: ${err.message}`);
          yield { type: 'agent:error', error: err, recoverable: true, timestamp: Date.now() };
          yield this.createTextDeltaEvent('\n[Response degraded — continuing with partial result]\n');
          return;
        }

        this.errorHandler.recordApiFailure(err);

        // Check circuit breaker
        if (!this.errorHandler.canExecuteApi()) {
          logger.query.warn('API circuit breaker is open, skipping request');
          yield this.createTextDeltaEvent('\n[API temporarily unavailable — please retry later]\n');
          return;
        }

        throw err;
      }
    }
  }

  private async *streamLLMResponse(
    requestConfig: LLMRequestConfig,
    _toolsDef: ToolDefinition[]
  ): AsyncGenerator<StreamEvent | AgentEvent> {
    let currentContent = '';
    let currentToolCalls: ToolCall[] = [];

    // Global timeout for LLM streaming to prevent infinite hangs.
    // Default 5 minutes; can be overridden via environment variable.
    const STREAM_TIMEOUT_MS = parseInt(process.env.KC_STREAM_TIMEOUT_MS || '300000', 10);
    const streamTimeoutMs = Number.isFinite(STREAM_TIMEOUT_MS) && STREAM_TIMEOUT_MS > 0
      ? STREAM_TIMEOUT_MS
      : 300000;

    const timeoutId = setTimeout(() => {
      this.abort('LLM stream timeout');
    }, streamTimeoutMs);
    timeoutId.unref?.();

    try {
      for await (const event of this.apiClient.streamChat(requestConfig)) {
        if (this._aborted) break;
        switch (event.type) {
          case 'text_delta':
            if (event.text) {
              currentContent += event.text;
              yield this.createTextDeltaEvent(event.text);
            }
            break;
          case 'thinking_delta':
            if (event.thinking) {
              yield this.createThinkingDeltaEvent(event.thinking);
            }
            break;
          case 'tool_use':
            if (event.toolCall) {
              currentToolCalls.push(event.toolCall);
            }
            break;
          case 'error':
            if (event.error) throw event.error;
            break;
          case 'stop':
            break;
        }
      }
    } catch (error) {
      if (this._aborted) {
        logger.query.warn(`[QueryEngine] LLM stream aborted after ${streamTimeoutMs / 1000}s`);
        throw new Error('LLM stream aborted');
      } else {
        throw error;
      }
    } finally {
      clearTimeout(timeoutId);
    }

    // Build assistant message (with whatever content we have)
    const assistantMsg: AssistantMessage = {
      id: uuidv4(),
      role: 'assistant',
      content: currentContent || '[stream interrupted]',
      toolCalls: currentToolCalls.length > 0 ? currentToolCalls : undefined,
      timestamp: Date.now(),
    };

    this.conversation.addMessage(assistantMsg);
    yield this.createTurnCompleteEvent(assistantMsg);
  }

  private async decidingPhase(turnCount: number = 0, minTurns: number = 0): Promise<boolean> {
    const lastMsg = this.conversation.getLastMessage();
    if (!lastMsg || lastMsg.role !== 'assistant') {
      // P1: If below minTurns, force continuation
      if (turnCount < minTurns) {
        return true; // Force agent to continue
      }
      return false;
    }

    const assistantMsg = lastMsg as AssistantMessage;
    const hasToolCalls = !!(assistantMsg.toolCalls && assistantMsg.toolCalls.length > 0);

    // P1: Anti-abandonment — if below minTurns and agent has no tool calls, force continuation
    if (!hasToolCalls && turnCount < minTurns) {
      logger.query.info(`[QueryEngine] Anti-abandonment: turn ${turnCount} < minTurns ${minTurns}, forcing continuation`);
      return true; // Force agent to continue
    }

    // P0: Forced commit on exit — if agent wants to exit with uncommitted changes, force a commit
    if (!hasToolCalls && this.modifiedFiles.size > 0) {
      try {
        const committed = await autoCommitAll(getState().cwd);
        if (committed) {
          logger.query.info(`[QueryEngine] Forced commit on exit: ${this.modifiedFiles.size} files`);
        }
      } catch {
        // Non-fatal
      }
    }

    // Area 2: Patch Guarantee — zero-patch detection (B1)
    if (!hasToolCalls) {
      const pgConfig: PatchGuaranteeConfig = {
        enabled: this.config.patchGuarantee?.enabled ?? true,
        maxZeroPatchRetries: this.config.patchGuarantee?.maxZeroPatchRetries ?? 3,
        maxVerificationRetries: this.config.patchGuarantee?.maxVerificationRetries ?? 2,
        verificationTimeout: this.config.patchGuarantee?.verificationTimeout ?? 60,
        testCommand: this.config.patchGuarantee?.testCommand ?? 'pytest {test_names} -x',
      };

      if (!pgConfig.enabled) return hasToolCalls;

      // B1: Zero-patch detection
      if (this.modifiedFiles.size === 0) {
        if (this.zeroPatchRetries < pgConfig.maxZeroPatchRetries) {
          this.zeroPatchRetries++;
          const remaining = pgConfig.maxZeroPatchRetries - this.zeroPatchRetries;
          const steerMsg = [
            '## PATCH REQUIRED',
            '',
            `You are about to exit but have modified ZERO files. Retry ${this.zeroPatchRetries}/${pgConfig.maxZeroPatchRetries}.`,
            '',
            'Before giving up, verify:',
            '1. Did you run the FAIL_TO_PASS tests? What exact error do they show?',
            '2. Did you read the source files related to those errors?',
            '3. Form a specific hypothesis and make at least one edit.',
            '',
            `You have ${remaining} more retry attempt(s) before this session is marked as failed.`,
          ].join('\n');

          logger.query.warn(`[QueryEngine] Zero-patch detection: retry ${this.zeroPatchRetries}/${pgConfig.maxZeroPatchRetries}`);
          this.steer(steerMsg);

          return true; // Force continuation
        }

        // Retries exhausted — emit structured error
        logger.query.error('[QueryEngine] Zero-patch retries exhausted — model_no_patch');
        return false; // Let the state machine handle the error
      }
    }

    // B2: Pre-exit test verification
    // Only when agent has modifications and test names are available
    if (this.modifiedFiles.size > 0) {
      const testNames = this.extractFailToPassTests();
      const pgConfig: PatchGuaranteeConfig = {
        enabled: this.config.patchGuarantee?.enabled ?? true,
        maxZeroPatchRetries: this.config.patchGuarantee?.maxZeroPatchRetries ?? 3,
        maxVerificationRetries: this.config.patchGuarantee?.maxVerificationRetries ?? 2,
        verificationTimeout: this.config.patchGuarantee?.verificationTimeout ?? 60,
        testCommand: this.config.patchGuarantee?.testCommand ?? 'pytest {test_names} -x',
      };

      if (pgConfig.enabled && testNames.length > 0 && this.verificationRetries < pgConfig.maxVerificationRetries) {
        const result = await this.verifyBeforeExit(testNames, pgConfig);

        if (!result.canExit && result.reason === 'tests_fail') {
          this.verificationRetries++;
          const failures = (result.failures || []).join('\n\n');
          const steerMsg = [
            `## VERIFICATION FAILED (${this.verificationRetries}/${pgConfig.maxVerificationRetries})`,
            '',
            'The following tests still do not pass:',
            '```',
            failures,
            '```',
            'Please fix these issues before exiting.',
          ].join('\n');

          this.steer(steerMsg);
          this.conversation.addMessage({
            id: `verification_failed_${Date.now()}`,
            role: 'user',
            content: steerMsg,
            timestamp: Date.now(),
          });

          return true; // Force continuation
        } else if (result.canExit && result.reason === 'tests_pass') {
          logger.query.info('[QueryEngine] Pre-exit verification: all tests pass');
        }
      }
    }

    return hasToolCalls;
  }

  private async *executingPhase(): AsyncGenerator<StreamEvent | AgentEvent> {
    const lastMsg = this.conversation.getLastMessage();
    if (!lastMsg || lastMsg.role !== 'assistant') return;

    const assistantMsg = lastMsg as AssistantMessage;
    const toolCalls = assistantMsg.toolCalls || [];

    for (const tc of toolCalls) {
      yield this.createToolStartedEvent(tc);
    }

    const results = await this.toolExecutor.executeParallel(
      toolCalls,
      this.createToolContext()
    );

    for (const [toolCallId, result] of results) {
      const toolCall = toolCalls.find(tc => tc.id === toolCallId);
      if (!toolCall) continue;

      // Track file modifications for incremental memory and patch guarantee
      if (!(result instanceof Error) && !result.isError) {
        const toolName = toolCall.toolName;
        if (toolName === 'FileWrite' || toolName === 'FileEdit') {
          const metadata = (result as ToolResult).metadata as Record<string, unknown> | undefined;
          const filePath = (metadata?.path || metadata?.file_path) as string | undefined;
          if (filePath) {
            this.modifiedFiles.add(filePath);
            this.lastModifiedTurn = this.stateStore.get().turnCount;
            // Auto-stage file (fire-and-forget git add)
            autoStageFile(filePath, getState().cwd);
          }
        }
      }

      if (result instanceof Error) {
        yield this.createToolFailedEvent(toolCall, result);
      } else if (result.isError) {
        yield this.createToolFailedEvent(toolCall, new Error(result.output));
      } else {
        yield this.createToolCompletedEvent(toolCall, result as ToolResult);
      }

      // Add tool result as message. Always preserve toolCallId so the tool
      // message can be paired with the originating assistant tool_call — an
      // Error result would otherwise drop it and break the OpenAI contract.
      const toolResultMsg: ChatMessage = {
        id: uuidv4(),
        role: 'tool',
        content: result instanceof Error ? result.message : (result as ToolResult).output,
        toolResults: [
          result instanceof Error
            ? { toolCallId, output: result.message, isError: true }
            : (result as ToolResult),
        ],
        timestamp: Date.now(),
      };
      this.conversation.addMessage(toolResultMsg);
    }
  }

  // ── Pre-Exit Test Verification (Area 2) ──

  /**
   * Validate that a test command doesn't contain shell injection patterns.
   * Only allows known test runners with sanitized arguments.
   */
  private isTestCommandSafe(command: string): boolean {
    // Reject shell metacharacters that enable command chaining, I/O redirection,
    // or escape sequences (SEC-06)
    if (/[;&|`$(){}$\n\r<>\\]/.test(command.replace('{test_names}', ''))) {
      return false;
    }
    // Allow only known test runner prefixes
    const allowedRunners = ['pytest', 'vitest', 'npx vitest', 'go test', 'cargo test', 'jest', 'npx jest', 'python -m pytest'];
    const trimmed = command.trim();
    return allowedRunners.some(runner => trimmed.startsWith(runner));
  }

  // Validate test names contain only safe characters (SEC-06)
  private isValidTestName(name: string): boolean {
    return /^[a-zA-Z0-9_\-./:]+$/.test(name);
  }

  /**
   * Check if a file read would be redundant (content unchanged since last read).
   * Returns shortened note if cached, null if fresh content should be used.
   */
  checkFileReadDedup(filePath: string, content: string): string | null {
    const cacheResult = this.fileContentCache.check(filePath, content);
    if (cacheResult !== 'fresh') {
      return `[File unchanged since turn ${cacheResult.cachedSince}: ${filePath} — use existing context.]`;
    }
    return null;
  }

  private async verifyBeforeExit(
    testNames: string[],
    config: PatchGuaranteeConfig
  ): Promise<VerificationResult> {
    if (!testNames.length) {
      return { canExit: true, reason: 'tests_not_found' };
    }

    // Validate test names independently to prevent injection (SEC-06)
    const invalidNames = testNames.filter(n => !this.isValidTestName(n));
    if (invalidNames.length > 0) {
      logger.query.warn(`[QueryEngine] Invalid test names rejected: ${invalidNames.join(', ')}`);
      return { canExit: true, reason: 'tests_not_found' };
    }

    const testList = testNames.join(' ');
    const command = config.testCommand.replace('{test_names}', testList);
    const cwd = getState().cwd;

    // Validate command to prevent shell injection
    if (!this.isTestCommandSafe(command)) {
      logger.query.warn(`[QueryEngine] Unsafe test command rejected: ${command.slice(0, 100)}`);
      return { canExit: true, reason: 'tests_not_found' };
    }

    try {
      const result = await new Promise<{ stdout: string; stderr: string; code: number }>(
        (resolve, reject) => {
          const child = spawn('bash', ['-c', command], {
            cwd,
            timeout: config.verificationTimeout * 1000,
            stdio: ['ignore', 'pipe', 'pipe'],
          });

          let stdout = '';
          let stderr = '';

          child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
          child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
          child.on('close', (code: number) => resolve({ stdout, stderr, code: code ?? 1 }));
          child.on('error', reject);
        }
      );

      const output = result.stdout + result.stderr;

      // Parse test results (pytest format: "10 passed, 2 failed")
      const failedMatch = output.match(/(\d+) failed/);
      const passedMatch = output.match(/(\d+) passed/);
      const totalFailed = failedMatch ? parseInt(failedMatch[1], 10) : 0;
      const totalPassed = passedMatch ? parseInt(passedMatch[1], 10) : 0;

      if (totalFailed === 0 && totalPassed > 0) {
        return { canExit: true, reason: 'tests_pass', output };
      }

      // Extract failure details (last 500 chars of each failure block)
      const failureBlocks = output.match(
        /FAILED[\s\S]*?={5,}[\s\S]*?(?=\n={5,}|\n_+ |$)/g
      );

      return {
        canExit: false,
        reason: 'tests_fail',
        failures: failureBlocks?.map(f => f.slice(0, 300)) || [output.slice(0, 500)],
        output,
      };
    } catch {
      // On infra failure (timeout, spawn error), don't block exit
      return { canExit: true, reason: 'timeout' };
    }
  }

  /**
   * Extract FAIL_TO_PASS test names from conversation or state.
   */
  private extractFailToPassTests(): string[] {
    // Check if tests were provided in state
    const state = getState() as any;
    if (state.failToPass && Array.isArray(state.failToPass)) {
      return state.failToPass;
    }

    // Fall back to scanning conversation for test references
    const messages = this.conversation.getMessages();
    for (const msg of messages) {
      const content = msg.content || '';
      const match = content.match(/FAIL_TO_PASS[:\s]+(.+)/i);
      if (match) {
        return match[1].split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
      }
    }
    return [];
  }

  private buildApiMessages(): ChatMessage[] {
    const messages = this.conversation.getMessagesCopy();
    const systemMsg = messages.find(m => m.role === 'system');
    const nonSystem = messages.filter(m => m.role !== 'system');

    // Defensive pairing: the OpenAI contract requires every assistant
    // tool_call id to be answered by a following tool message with the same
    // tool_call_id. If any id is unanswered (e.g. a tool crashed before
    // producing a result), synthesize a placeholder tool message so the API
    // does not reject the request with HTTP 400.
    const repaired: ChatMessage[] = [];
    for (let i = 0; i < nonSystem.length; i++) {
      const msg = nonSystem[i];
      repaired.push(msg);

      if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
        // Consume the immediately-following tool messages and record which
        // tool_call ids they answer.
        const answered = new Set<string>();
        let j = i + 1;
        while (j < nonSystem.length && nonSystem[j].role === 'tool') {
          for (const tr of nonSystem[j].toolResults || []) {
            if (tr.toolCallId) answered.add(tr.toolCallId);
          }
          repaired.push(nonSystem[j]);
          j++;
        }

        // Synthesize placeholders for any unanswered tool_call ids.
        for (const tc of msg.toolCalls) {
          if (!answered.has(tc.id)) {
            repaired.push({
              id: uuidv4(),
              role: 'tool',
              content: 'Tool execution did not produce a result.',
              toolResults: [{ toolCallId: tc.id, output: 'Tool execution did not produce a result.', isError: true }],
              timestamp: Date.now(),
            } as ChatMessage);
          }
        }

        i = j - 1; // Skip the tool messages already appended above.
      }
    }

    return systemMsg ? [systemMsg, ...repaired] : repaired;
  }

  private createToolContext(): ToolUseContext {
    return {
      cwd: getState().cwd,
      abortController: this.abortController,
      permissions: buildPermissionContext(),
      sandbox: this.toolExecutor.getSandboxManager(),
      env: this.toolExecutor.getExecutionEnv(),
    };
  }

  // Event factory methods
  private createTextDeltaEvent(text: string): AgentEvent {
    return { type: 'agent:text_delta', text, timestamp: Date.now() };
  }

  private createThinkingDeltaEvent(thinking: string): AgentEvent {
    return { type: 'agent:thinking_delta', thinking, timestamp: Date.now() };
  }

  private createTurnCompleteEvent(message: AssistantMessage): AgentEvent {
    return {
      type: 'agent:turn_complete',
      message,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      timestamp: Date.now(),
    };
  }

  private createToolStartedEvent(toolCall: ToolCall): AgentEvent {
    return { type: 'agent:tool_started', toolCall, timestamp: Date.now() };
  }

  private createToolCompletedEvent(toolCall: ToolCall, result: ToolResult): AgentEvent {
    return { type: 'agent:tool_completed', toolCall, result, timestamp: Date.now() };
  }

  private createToolFailedEvent(toolCall: ToolCall, error: Error): AgentEvent {
    return { type: 'agent:tool_failed', toolCall, error, timestamp: Date.now() };
  }

  private createCompleteEvent(): AgentEvent {
    return { type: 'agent:complete', timestamp: Date.now() };
  }

  private _aborted = false;

  /** Abort the current query */
  abort(reason?: string): void {
    this._aborted = true;
    this.abortController.abort(reason);
  }

  /** Check if the current query is aborted */
  isAborted(): boolean {
    return this._aborted;
  }

  /** Clear conversation history and reset state */
  clear(): void {
    this.conversation.clear();
    this.compaction.reset();
    this.errorHandler.reset();
    this._aborted = false;
    this.steerQueue = [];
    this.followUpQueue = [];
    this.modifiedFiles.clear();
    this.lastModifiedTurn = 0;
    this.zeroPatchRetries = 0;
    this.verificationRetries = 0;
    this.planningHandler.reset();
    this.fileContentCache.invalidateAll();
    this.readHistory.clear();
    this.editHistory.clear();
    this.abortController = new AbortController();
    if (this.stateMachine.currentState !== 'idle') {
      this.stateMachine.forceTransitionTo('idle');
    }
  }

  // ── Dual-Queue Steering System ──

  /**
   * Enqueue a steer message. Steer messages are injected into the conversation
   * between tool execution phases, redirecting the agent mid-turn.
   * Thread-safe: messages are queued and drained at controlled points in the loop.
   */
  steer(message: string): void {
    this.steerQueue.push({
      role: 'user',
      content: message,
      timestamp: Date.now(),
    } as ChatMessage);
  }

  /**
   * Enqueue a follow-up message. Follow-up messages are injected after the
   * current turn completes (no more tool calls), starting a new implicit turn.
   * Thread-safe: messages are queued and drained at controlled points in the loop.
   */
  followUp(message: string): void {
    this.followUpQueue.push({
      role: 'user',
      content: message,
      timestamp: Date.now(),
    } as ChatMessage);
  }

  /** Whether the steering system is enabled */
  isSteeringEnabled(): boolean {
    return this.steeringEnabled;
  }

  /** Get the current steer queue length */
  getSteerQueueLength(): number {
    return this.steerQueue.length;
  }

  /** Get the current followUp queue length */
  getFollowUpQueueLength(): number {
    return this.followUpQueue.length;
  }

  /**
   * Drain all messages from the steer queue (atomically).
   * Returns the drained messages and resets the queue.
   */
  private drainSteerQueue(): ChatMessage[] {
    if (this.steerQueue.length === 0) return [];
    const drained = this.steerQueue;
    this.steerQueue = [];
    return drained;
  }

  /**
   * Drain all messages from the followUp queue (atomically).
   * Returns the drained messages and resets the queue.
   */
  private drainFollowUpQueue(): ChatMessage[] {
    if (this.followUpQueue.length === 0) return [];
    const drained = this.followUpQueue;
    this.followUpQueue = [];
    return drained;
  }

  /** Get the current message count */
  get messageCount(): number {
    return this.conversation.messageCount;
  }

  /** Get the state machine (for testing) */
  getStateMachine(): AgentStateMachine {
    return this.stateMachine;
  }

  /** Get the state store (for testing) */
  getStateStore(): ObservableStateStore {
    return this.stateStore;
  }

  /** Expose the tool executor (for testing) */
  getToolExecutor(): ToolExecutor {
    return this.toolExecutor;
  }

  /** Expose the error handler (for testing) */
  getErrorHandler(): ErrorHandler {
    return this.errorHandler;
  }

  /** Get messages (backward compat) */
  getMessages(): ChatMessage[] {
    return this.conversation.getMessages();
  }

  /** Get memory integration (backward compat) */
  getMemoryIntegration() {
    return this.memory.getIntegration();
  }

  /** Get messages as getter (backward compat) */
  get messages(): ChatMessage[] {
    return this.conversation.getMessages();
  }

  /** Set messages (backward compat, delegates to conversation state) */
  set messages(msgs: ChatMessage[]) {
    this.conversation.setMessages(msgs);
  }

  /** Get memory integration as getter (backward compat) */
  get memoryIntegration() {
    return this.memory.getIntegration();
  }

  /** Trim messages (backward compat, delegates to conversation state) */
  trimMessages(): void {
    this.conversation.trimIfNeeded();
  }

  /** Create a new conversation branch. Returns the new branch node ID. */
  branch(): string {
    return this.conversation.branch();
  }

  /** Switch to a different branch by node ID. */
  checkout(nodeId: string): void {
    this.conversation.checkout(nodeId);
  }

  /** Get the session tree structure for visualization. */
  getTree() {
    return this.conversation.getTree();
  }

  /** Get the underlying SessionTree instance (for branch label management). */
  getSessionTree() {
    return this.conversation.getSessionTree();
  }

  /** Get tracked modified files */
  getModifiedFiles(): string[] {
    return Array.from(this.modifiedFiles);
  }
}
