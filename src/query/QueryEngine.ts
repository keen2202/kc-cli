import { logger } from '../services/logger';
// Query Engine - Refactored with state machine pattern
// Inspired by OpenHarness's query loop architecture
// Sub-modules (State, Compaction, Memory, Error, Planning, Importance,
// RuntimeControl, Decision, TurnControl, Streaming, Execution) handle
// specific phases to keep QueryEngine as a facade.

import type { ChatMessage, StreamEvent, AssistantMessage, QueryEngineConfig } from '../query/protocol';
import type { SessionSnapshot } from '../memory/protocol';
import type { ToolDefinition, ToolUseContext } from '../tools/protocol';
import { AgentStateMachine } from '../state/machine';
import { ObservableStateStore, createInitialState } from '../state/store';
import { ToolExecutor } from '../executors/toolExecutor';
import { FileOperationJournal } from '../state/file-operation-journal';
import type { AgentEvent } from '../state/types';
import { buildPermissionContext } from '../permissions/engine';
import { getState } from '../bootstrap/state';
import { executePostTurnHooks } from '../hooks/postTurnHooks';
import { createAPIClient } from '../api';
import type { BaseApiClient, LLMRequestConfig } from '../api';
import { UserProfileService } from '../services/userProfile';
import { getSystemPromptAdaptation } from '../services/behavioralAdapter';
import { PromptCacheMetrics } from '../services/promptCacheMetrics';
import { CachePrefixService, buildCacheStrategy } from '../services/cachePrefix';
import { estimateTaskComplexity, isConversationalMessage } from '../api/prompts/task-prompts';
import { KCError } from '../utils/errors';
import { validateApiKey } from '../utils/api-key';
import { BudgetEnforcer, DEFAULT_BUDGET_CONFIG, type BudgetConfig } from '../services/budget';
import { queryOperationAudit } from '../services/operation-audit-log';
import {
  buildAcceptanceReport,
  writeAcceptanceReport,
  skippedGate,
} from './completion-report';

// Sub-modules
import { ConversationState } from './QueryEngineState';
import { CompactionHandler } from './QueryEngineCompaction';
import { MemoryHandler } from './QueryEngineMemory';
import { ErrorHandler } from './QueryEngineError';
import { DecisionGates } from './QueryEngineDecision';
import { afterStreamingTurn, type ProgressTracker } from './QueryEngineTurnControl';
import { executeToolCalls } from './QueryEngineExecution';
import { streamLLMTurn, buildApiMessages } from './QueryEngineStreaming';
import { textDeltaEvent } from './QueryEngineEvents';

import { PlanningPhaseHandler } from './QueryEnginePlanning';

import { v4 as uuidv4 } from 'uuid';

import { FileContentCache } from '../services/cache/FileContentCache';
import { ImportanceTagger } from './QueryEngineImportance';
import { RuntimeControlHandler } from './QueryEngineRuntimeControl';
import { computeSurfaceRuntime, buildConditionalInjection } from '../api/prompts/instruction-surfaces';

// QueryEngineConfig moved to protocol.ts (4e); re-exported for API stability.
export type { QueryEngineConfig } from './protocol';

/**
 * T24 phase 1: optional dependency-injection surface for QueryEngine.
 * Every collaborator previously hard-instantiated (`new X(...)`) can be
 * substituted by tests; each parameter defaults to exactly the instantiation
 * the constructor performed before this change, so the no-deps construction
 * path is behavior-identical.
 */
export interface QueryEngineDeps {
  stateStore: ObservableStateStore;
  stateMachine: AgentStateMachine;
  conversation: ConversationState;
  compaction: CompactionHandler;
  memory: MemoryHandler;
  errorHandler: ErrorHandler;
  toolExecutor: ToolExecutor;
  userProfile: UserProfileService;
  budgetEnforcer: BudgetEnforcer;
  cacheMetrics: PromptCacheMetrics;
  cachePrefix: CachePrefixService;
  fileContentCache: FileContentCache;
  importanceTagger: ImportanceTagger;
  fileJournal: FileOperationJournal;
  decision: DecisionGates;
  planningHandler: PlanningPhaseHandler;
  runtimeControl: RuntimeControlHandler;
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

  // Cache metrics tracking (T24 phase 1: injectable, defaults preserved)
  private cacheMetrics: PromptCacheMetrics;

  // Cache prefix service for byte-stable prompt prefixes
  private cachePrefix: CachePrefixService;

  // Dual-queue steering system
  private steerQueue: ChatMessage[] = [];
  private followUpQueue: ChatMessage[] = [];
  private steeringEnabled = true;

  // File modification tracking (for incremental memory and patch guarantee)
  private modifiedFiles: Set<string> = new Set();
  // Progress signals for turn auto-extension (file edits vs. tool activity);
  // mutated by the execution / turn-control sub-modules via this shared tracker.
  private progress: ProgressTracker = { lastModifiedTurn: 0, lastProgressTurn: 0 };
  // T3 (H3): session-scoped undo journal, consumed by the FileRestore tool.
  // (T24 phase 1: injectable, defaults preserved)
  private fileJournal: FileOperationJournal;

  // Area 3: Context efficiency components
  private fileContentCache: FileContentCache;
  private importanceTagger: ImportanceTagger;
  private readHistory = new Map<string, number>();
  private editHistory = new Map<string, number>();

  // Area 1: Planning phase handler
  private planningHandler: PlanningPhaseHandler;

  // Area 2: Patch Guarantee — exit gates (zero-patch / verification /
  // type-check retry budgets + T7/M2 gate reports) live in the DecisionGates
  // sub-module (QueryEngineDecision.ts).
  // (T24 phase 1: injectable, defaults preserved)
  private decision: DecisionGates;

  // Conversational-query exemption: greetings/small talk skip the SWE-bench
  // machinery (phase steers, anti-abandonment, patch guarantee) so a plain
  // answer with zero tool calls completes normally. Set per submitMessage().
  private activeQueryConversational = false;

  // T3: Budget enforcement
  private budgetEnforcer: BudgetEnforcer;

  // harness-evolution T2 (H2): cross-turn runtime control policy handler
  private runtimeControl: RuntimeControlHandler;

  constructor(config: QueryEngineConfig, tools: ToolDefinition[], deps?: Partial<QueryEngineDeps>) {
    const d = deps ?? {};
    this.config = config;
    this.abortController = new AbortController();

    // T24 phase 1: these three were field initializers before; hoisted here
    // verbatim (same defaults, nothing reads them earlier in construction).
    this.cacheMetrics = d.cacheMetrics ?? new PromptCacheMetrics();
    this.fileJournal = d.fileJournal ?? new FileOperationJournal();
    this.decision = d.decision ?? new DecisionGates();

    // Initialize API client
    this.apiClient = createAPIClient({
      provider: config.provider,
      apiKey: config.apiKey || process.env.KC_API_KEY || '',
      baseUrl: config.apiBaseUrl,
      model: config.model,
    });

    // Initialize budget enforcer. Hoisted above the sub-modules so the
    // memory LLM-extraction tier can share this same enforcer (GR6).
    this.budgetEnforcer = d.budgetEnforcer ?? new BudgetEnforcer({
      sessionTokenLimit: config.maxBudgetUsd
        ? Math.ceil(config.maxBudgetUsd / 0.00001) // rough token-per-dollar estimate
        : DEFAULT_BUDGET_CONFIG.sessionTokenLimit,
      costLimitUsd: config.maxBudgetUsd ?? null,
    });

    // Initialize sub-modules
    this.conversation = d.conversation ?? new ConversationState({
      maxMessages: config.maxMessages,
    });
    this.compaction = d.compaction ?? new CompactionHandler();
    // Memory integration: default-inject the engine's own API client and
    // budget enforcer so the hybrid LLM-extraction tier (spec:
    // memory-llm-extraction-hardening) can actually fire when
    // `llmExtraction.enabled` is turned on. The extraction call still goes
    // through the isolated path in memoryExtraction.ts (no QueryEngine, no
    // post-turn hooks — GR5 recursion isolation is preserved). Explicitly
    // provided values in config.memory (including an explicit null) win
    // over these defaults.
    this.memory = d.memory ?? new MemoryHandler({
      llmClient: this.apiClient,
      budget: this.budgetEnforcer,
      ...config.memory,
    });
    this.errorHandler = d.errorHandler ?? new ErrorHandler();

    // Initialize state store
    this.stateStore = d.stateStore ?? new ObservableStateStore(createInitialState({
      model: config.model,
      provider: config.provider,
      maxTurns: config.maxTurns,
      maxBudgetUsd: config.maxBudgetUsd,
    }));

    // Initialize state machine
    this.stateMachine = d.stateMachine ?? new AgentStateMachine(this.stateStore);

    // Initialize tool executor with permission config from user settings
    const rules = config.permissionRules || {};
    this.toolExecutor = d.toolExecutor ?? new ToolExecutor(tools, getState().cwd, {
      alwaysDenyRules: rules.deny || [],
      alwaysAskRules: rules.ask || [],
      alwaysAllowRules: rules.allow || [],
    }, undefined, {
      failIfNoSandbox: config.sandboxFailIfNoSandbox,
    });

    // T1 (H1): inject the non-interactive 'ask' fail-safe policy (default 'deny').
    this.toolExecutor.setNoninteractiveAskPolicy(config.noninteractiveAskPolicy ?? 'deny');

    // Initialize user profile (level-based adaptation)
    this.userProfile = d.userProfile ?? new UserProfileService();

    // Initialize cache prefix service
    this.cachePrefix = d.cachePrefix ?? new CachePrefixService(
      config.provider,
      buildCacheStrategy(config.provider),
    );

    // Initialize context efficiency components
    this.fileContentCache = d.fileContentCache ?? new FileContentCache(
      config.contextEfficiency?.dedupCacheSize ?? 500
    );
    this.importanceTagger = d.importanceTagger ?? new ImportanceTagger();

    // Initialize planning phase handler
    this.planningHandler = d.planningHandler ?? new PlanningPhaseHandler(config.planningPhase || {});

    // harness-evolution T2 (H2): runtime control policy (default disabled)
    this.runtimeControl = d.runtimeControl ?? new RuntimeControlHandler(config.runtimeControl);

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
   * Register an interactive permission handler that the executor invokes when
   * a tool requires explicit user authorization ('ask'). Pass null to detach.
   */
  setPermissionRequestHandler(
    handler: import('../permissions/protocol').UIPermissionRequestHandler | null,
  ): void {
    this.toolExecutor.setPermissionRequestHandler(handler);
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
   * Switch the active model at runtime (e.g., from the /model command).
   * Recreates the API client under the current provider/key/baseUrl so the
   * next turn uses the new model. Returns the applied model name.
   */
  setModel(model: string): string {
    this.config.model = model;
    this.apiClient = createAPIClient({
      provider: this.config.provider,
      apiKey: this.config.apiKey,
      baseUrl: this.config.apiBaseUrl,
      model,
    });
    return model;
  }

  /**
   * Reset per-query control state so a new user message starts a fresh query
   * loop while preserving the conversation history.
   *
   * Without this, the state machine stays in a terminal state ('completed' or
   * 'error') after the previous turn, and the `while (!isTerminal())` guard in
   * submitMessage() short-circuits immediately — yielding zero events (the UI
   * shows a running state but produces no output/stream). A prior stream
   * timeout or user abort would likewise leave `_aborted`/`abortController`
   * poisoned for every subsequent query.
   *
   * Unlike clear()/restoreSession(), this does NOT touch messages, so multi-turn
   * context is retained.
   */
  private resetForNewQuery(): void {
    // A previous timeout/abort must not poison the new query.
    if (this._aborted || this.abortController.signal.aborted) {
      this._aborted = false;
      this.abortController = new AbortController();
    }
    // Return the loop to a runnable state from any terminal/leftover state.
    if (this.stateMachine.currentState !== 'idle') {
      this.stateMachine.forceTransitionTo('idle');
    }
    // Each user query gets a fresh retry budget: without this, zero-patch /
    // verification retry counters accumulate across queries and a few plain
    // Q&A turns (classified as task-like, modifying no files) exhaust the
    // budget and poison every subsequent query with model_no_patch.
    this.decision.reset();
  }

  /**
   * Main query entry point - uses state machine to manage lifecycle
   */
  async *submitMessage(userMessage: string): AsyncGenerator<StreamEvent | AgentEvent> {
    // Reset per-query control state (state machine + abort) before starting a
    // new loop. Conversation history is preserved.
    this.resetForNewQuery();

    // Classify once per query: conversational messages (greetings, small talk,
    // simple Q&A) are exempt from the SWE-bench task machinery below.
    this.activeQueryConversational = isConversationalMessage(userMessage);

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
      // Ceiling semantics: 0 or negative = unbounded — an actively-progressing
      // long task is never cut off by the ceiling (stall detection below still
      // stops a stagnant agent at the current budget).
      const ceilingRaw = this.config.maxTurnsCeiling ?? 100;
      const maxTurnsCeiling = ceilingRaw <= 0 ? Number.POSITIVE_INFINITY : ceilingRaw;
      const autoExtend = this.config.autoExtendTurns || false;

      // Complexity-aware turn adjustment (only if no explicit CLI override)
      if (!getState().maxTurns) {
        const estimate = estimateTaskComplexity(userMessage);
        if (estimate.suggestedTurns > maxTurns) {
          const adjusted = Math.min(estimate.suggestedTurns, maxTurnsCeiling);
          logger.query.info(`[QueryEngine] Task complexity: ${estimate.complexity}, adjusting maxTurns ${maxTurns} → ${adjusted}`);
          maxTurns = adjusted;
        } else if (this.activeQueryConversational && estimate.suggestedTurns < maxTurns) {
          // Conversational queries converge to the small suggested budget
          // instead of inheriting the task-sized default.
          logger.query.info(`[QueryEngine] Conversational query: reducing maxTurns ${maxTurns} → ${estimate.suggestedTurns}`);
          maxTurns = estimate.suggestedTurns;
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

          case 'idle': {
            // Skip planning phase for conversational messages (greetings, small
            // talk, simple questions) — they don't need code exploration.
            const lastUserMsg = this.conversation.findLastUserMessage();
            const isConversational = lastUserMsg?.content
              ? isConversationalMessage(lastUserMsg.content)
              : false;

            if (this.planningHandler.isEnabled && !isConversational) {
              this.stateMachine.transitionTo('planning');
            } else {
              this.stateMachine.transitionTo('compacting');
            }
            break;
          }

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
            // T3: If budget exceeded (or other terminal event) during streaming,
            // stop the loop immediately to avoid re-entering deciding.
            if (this.stateMachine.isTerminal()) break;
            turnCount++;

            // Post-streaming turn orchestration (QueryEngineTurnControl):
            // progress tracking, importance tagging, phase steers, periodic
            // auto-commit, anti-abandonment and turn-budget extension.
            const budget = { maxTurns, maxTurnsCeiling, autoExtend };
            yield* afterStreamingTurn(
              {
                conversation: this.conversation,
                fileContentCache: this.fileContentCache,
                importanceTagger: this.importanceTagger,
                readHistory: this.readHistory,
                editHistory: this.editHistory,
                modifiedFiles: this.modifiedFiles,
                progress: this.progress,
                conversational: this.activeQueryConversational,
                importanceTagging: this.config.contextEfficiency?.importanceTagging ?? true,
                autoCommitInterval: this.config.autoCommitInterval || 0,
                minTurns: this.config.minTurns || 0,
                cwd: getState().cwd,
                steer: (m) => this.steer(m),
              },
              turnCount,
              budget,
            );
            maxTurns = budget.maxTurns;
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

            // Area 2: Zero-patch exhaustion error (strict mode only). By
            // default the query completes normally with the model's text
            // answer; SWE-bench runs opt into the hard failure via
            // patchGuarantee.failOnZeroPatch.
            // (T24 phase 1: block extracted to zeroPatchExhaustedEvent().)
            const zeroPatchError = this.zeroPatchExhaustedEvent(hasTools);
            if (zeroPatchError) yield zeroPatchError;

            if (hasTools) {
              this.stateMachine.transitionTo('executing');
            } else {
              // Turn complete — drain followUpQueue before finishing
              // (T24 phase 1: block extracted to drainFollowUpsIntoConversation().)
              if (this.drainFollowUpsIntoConversation()) break;
              this.stateMachine.transitionTo('completed');
              // Dispatch post-turn hooks (fire-and-forget): plugin postTurn
              // hooks and the T8 failure-signature → memory bridging hook run
              // off this path; hook errors never affect query completion.
              // (T24 phase 1: dispatch extracted to dispatchPostTurnHooks().)
              this.dispatchPostTurnHooks();
              yield this.createCompleteEvent(turnCount);
            }
            break;

          case 'executing':
            yield* this.executingPhase();
            if (!this.stateMachine.isTerminal()) {
              // Drain steerQueue after execution before going back to streaming
              // (T24 phase 1: block extracted to drainSteersIntoConversation().)
              yield* this.drainSteersIntoConversation();
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

  // ── Extracted state-machine business blocks (T24 phase 1) ──
  // These were inline bodies inside the submitMessage() switch; extracted
  // verbatim (same conditions, same ordering, same side effects) to slim the
  // state machine without changing observable behavior.

  /**
   * Area 2: Zero-patch exhaustion gate (deciding-phase exit check).
   *
   * Zero-patch exhaustion error (strict mode only). By default the query
   * completes normally with the model's text answer; SWE-bench runs opt into
   * the hard failure via patchGuarantee.failOnZeroPatch.
   *
   * @returns the terminal `agent:error` event to emit when zero-patch retries
   * are exhausted under failOnZeroPatch, otherwise null. The soft-path warn
   * log fires exactly where it did inline.
   */
  private zeroPatchExhaustedEvent(hasTools: boolean): AgentEvent | null {
    if (!(!hasTools && this.decision.zeroPatchRetries > 0 && this.modifiedFiles.size === 0)) {
      return null;
    }
    const maxRetries = this.config.patchGuarantee?.maxZeroPatchRetries ?? 3;
    if (this.decision.zeroPatchRetries < maxRetries) {
      return null;
    }
    if (this.config.patchGuarantee?.failOnZeroPatch) {
      const err = new KCError(
        'model_no_patch',
        'Agent exited without modifying any files after exhausting zero-patch retries',
        { zeroPatchRetries: this.decision.zeroPatchRetries }
      );
      return {
        type: 'agent:error',
        error: err,
        recoverable: false,
        timestamp: Date.now(),
      } as AgentEvent;
    }
    logger.query.warn(
      `[QueryEngine] Zero-patch retries exhausted (${this.decision.zeroPatchRetries}) — completing without patch (failOnZeroPatch disabled)`
    );
    return null;
  }

  /**
   * Dispatch post-turn hooks (fire-and-forget): plugin postTurn hooks and the
   * T8 failure-signature → memory bridging hook run off this path; hook errors
   * never affect query completion.
   */
  private dispatchPostTurnHooks(): void {
    void executePostTurnHooks({
      messages: this.conversation.getMessages(),
      systemPrompt: this.config.systemPrompt ?? '',
      state: this.stateStore.get(),
      querySource: 'query-engine',
    });
  }

  /**
   * Turn complete — drain followUpQueue into the conversation and reset the
   * state machine so the queued messages start a new implicit turn.
   *
   * @returns true when follow-ups were drained (caller must `break` to re-enter
   * the loop at 'streaming'), false when the queue was empty.
   */
  private drainFollowUpsIntoConversation(): boolean {
    const followUps = this.drainFollowUpQueue();
    if (followUps.length === 0) return false;
    for (const msg of followUps) {
      this.conversation.addMessage(msg);
    }
    // Reset state machine to continue processing
    this.stateMachine.forceTransitionTo('streaming');
    return true;
  }

  /**
   * Drain steerQueue after execution and inject each steered message into the
   * conversation, emitting one `agent:steered` event per message.
   */
  private *drainSteersIntoConversation(): Generator<AgentEvent> {
    const steered = this.drainSteerQueue();
    for (const msg of steered) {
      this.conversation.addMessage(msg);
      yield { type: 'agent:steered', message: msg, timestamp: Date.now() };
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

    // T3: Budget check before provider call
    const estimatedTokens = this.conversation.getTokenEstimate();
    const budgetCheck = this.budgetEnforcer.checkTurnBudget(estimatedTokens);
    if (!budgetCheck.allowed) {
      logger.query.warn(`[QueryEngine] Budget exceeded: ${budgetCheck.reason}`);
      yield {
        type: 'agent:budget_exceeded',
        reason: budgetCheck.reason,
        remaining: budgetCheck.remaining,
        timestamp: Date.now(),
      } as AgentEvent;
      this.stateMachine.forceTransitionTo('completed');
      return;
    }

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

    // harness-evolution T1 (H1): conditional instruction surfaces, appended as
    // the LAST system segment via the ephemeral zone (KV prefix-cache safe).
    // Gated by promptSurfaces.conditionalInjection (default off).
    let conditionalInjection = '';
    if (this.config.promptSurfaces?.conditionalInjection) {
      const runtime = computeSurfaceRuntime(this.conversation.getMessages());
      conditionalInjection = buildConditionalInjection(runtime);
    }
    // harness-evolution T2 (H2): drain queued runtime-control interventions
    // (empty string when the policy switch is off).
    const runtimeInjection = this.runtimeControl.drainPendingInjections();

    const ephemeralParts = [
      ...(ephemeral ? [ephemeral.levelAdaptation, ephemeral.memoryContext] : []),
      conditionalInjection,
      runtimeInjection,
    ].filter(Boolean);
    const ephemeralContent = ephemeralParts.length > 0 ? ephemeralParts.join('\n\n') : undefined;

    for (let retryAttempt = 0; retryAttempt <= maxRetries; retryAttempt++) {
      // If aborted, break to error state instead of continuing
      if (this._aborted) {
        throw new Error('Query aborted during streaming');
      }
      const apiMessages = buildApiMessages(this.conversation.getMessagesCopy());

      const requestConfig: LLMRequestConfig = {
        model: this.config.model,
        messages: apiMessages,
        tools: toolsDef,
        systemPrompt: stableSystemPrompt,
        ephemeralContent,
        abortSignal: this.abortController.signal,
      };

      try {
        yield* streamLLMTurn(
          {
            apiClient: this.apiClient,
            isAborted: () => this._aborted,
            abort: (reason) => this.abort(reason),
            addMessage: (m) => this.conversation.addMessage(m),
          },
          requestConfig,
        );
        this.errorHandler.recordApiSuccess();
        this.budgetEnforcer.recordUsage(estimatedTokens);
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
          yield textDeltaEvent('\n[Response degraded — continuing with partial result]\n');
          return;
        }

        this.errorHandler.recordApiFailure(err);

        // Check circuit breaker
        if (!this.errorHandler.canExecuteApi()) {
          logger.query.warn('API circuit breaker is open, skipping request');
          // Surface a real error event (not just inline text) so the UI error
          // bar and non-UI consumers are notified instead of failing silently.
          const cbError = new KCError(
            'api_server_error',
            'API circuit breaker is open — too many consecutive API failures',
            { lastError: err.message },
            err,
          );
          yield { type: 'agent:error', error: cbError, recoverable: false, timestamp: Date.now() };
          yield textDeltaEvent('\n[API temporarily unavailable — please retry later]\n');
          return;
        }

        throw err;
      }
    }
  }

  // streamLLMResponse moved to QueryEngineStreaming.ts (streamLLMTurn, 4e).

  /**
   * Phase 3: Exit-gate decisions — delegates to the DecisionGates sub-module
   * (anti-abandonment, forced commit on exit, zero-patch detection B1,
   * pre-exit type-check/test verification B2/B3).
   */
  private decidingPhase(turnCount: number = 0, minTurns: number = 0): Promise<boolean> {
    return this.decision.decide({
      turnCount,
      minTurns,
      conversational: this.activeQueryConversational,
      cwd: getState().cwd,
      modifiedFilesCount: this.modifiedFiles.size,
      patchGuarantee: this.config.patchGuarantee,
      getLastMessage: () => this.conversation.getLastMessage(),
      getMessages: () => this.conversation.getMessages(),
      steer: (m) => this.steer(m),
      addMessage: (m) => this.conversation.addMessage(m),
    });
  }

  /**
   * Phase 4: Tool execution — delegates to the execution sub-module
   * (parallel execution, journal/auto-stage tracking, runtime control).
   */
  private executingPhase(): AsyncGenerator<StreamEvent | AgentEvent> {
    return executeToolCalls({
      conversation: this.conversation,
      toolExecutor: this.toolExecutor,
      runtimeControl: this.runtimeControl,
      fileJournal: this.fileJournal,
      modifiedFiles: this.modifiedFiles,
      progress: this.progress,
      getTurnCount: () => this.stateStore.get().turnCount,
      toolContext: this.createToolContext(),
    });
  }

  // ── Pre-Exit Verification ──
  // Extracted to QueryEngineVerification.ts (verifyBeforeExit,
  // verifyTypeCheckBeforeExit, safety validators, gate-report mappers).
  // Tool execution moved to QueryEngineExecution.ts (executeToolCalls, 4e).

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

  // buildApiMessages moved to QueryEngineStreaming.ts (4e).

  private createToolContext(): ToolUseContext {
    return {
      cwd: getState().cwd,
      abortController: this.abortController,
      permissions: buildPermissionContext(),
      sandbox: this.toolExecutor.getSandboxManager(),
      env: this.toolExecutor.getExecutionEnv(),
      journal: this.fileJournal,
    };
  }

  // Event factories moved to QueryEngineEvents.ts (4e).

  /**
   * T7 (M2): build the task-completion acceptance report from already-tracked
   * signals (no extra LLM call) and attach it to the `agent:complete` event.
   * Best-effort disk persistence to `.kc-cli/reports/` is fire-and-forget.
   */
  private createCompleteEvent(turnCount: number): AgentEvent {
    let report: ReturnType<typeof buildAcceptanceReport> | undefined;
    try {
      const sessionId = this.getReportSessionId();
      const usage = this.budgetEnforcer.getSessionUsage();
      report = buildAcceptanceReport({
        sessionId,
        turnCount,
        modifiedFiles: Array.from(this.modifiedFiles),
        journalEntries: this.fileJournal.list(),
        typeCheck: this.decision.lastTypeCheckGate ?? skippedGate(),
        tests: this.decision.lastTestGate ?? skippedGate(),
        auditEntries: queryOperationAudit({ sessionId }),
        tokens: { inputTokens: 0, outputTokens: 0, totalTokens: usage.tokens },
      });
      // Optional persistence — never blocks or fails completion.
      void writeAcceptanceReport(report, getState().cwd);
    } catch {
      report = undefined;
    }
    return { type: 'agent:complete', timestamp: Date.now(), ...(report ? { report } : {}) };
  }

  /** Resolve the session ID for the report, defaulting when state is absent. */
  private getReportSessionId(): string {
    try {
      return getState().sessionId;
    } catch {
      return this.stateStore.get().sessionId ?? 'unknown';
    }
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
    this.progress.lastModifiedTurn = 0;
    this.progress.lastProgressTurn = 0;
    this.decision.reset();
    this.planningHandler.reset();
    this.fileContentCache.invalidateAll();
    this.readHistory.clear();
    this.editHistory.clear();
    this.abortController = new AbortController();
    this.budgetEnforcer.reset();
    if (this.stateMachine.currentState !== 'idle') {
      this.stateMachine.forceTransitionTo('idle');
    }
  }

  /**
   * Restore session from a snapshot (e.g. loaded from disk).
   *
   * Replaces the current conversation with the snapshot's messages, resets
   * compaction cursors and internal counters, and validates that the snapshot
   * contains at minimum the first system+user message pair. On failure the
   * current session is left untouched.
   *
   * @returns The restored turnCount for UI synchronization.
   * @throws {Error} If the snapshot is missing required messages.
   */
  restoreSession(snapshot: SessionSnapshot): number {
    // Validate snapshot integrity — must have at least system + user messages
    const msgs = snapshot.messages;
    if (!msgs || msgs.length === 0) {
      throw new Error('Session snapshot is empty');
    }
    const hasSystem = msgs.some(m => m.role === 'system');
    const hasUser = msgs.some(m => m.role === 'user');
    if (!hasSystem || !hasUser) {
      throw new Error('Session snapshot is missing required system or user message');
    }

    // Reset all internal state to a clean slate
    this.compaction.reset();
    this.errorHandler.reset();
    this._aborted = false;
    this.steerQueue = [];
    this.followUpQueue = [];
    this.modifiedFiles.clear();
    this.progress.lastModifiedTurn = 0;
    this.progress.lastProgressTurn = 0;
    this.decision.reset();
    this.planningHandler.reset();
    this.fileContentCache.invalidateAll();
    this.readHistory.clear();
    this.editHistory.clear();
    this.abortController = new AbortController();
    this.budgetEnforcer.reset();

    // Replace messages via the controlled API — this also resets the
    // SessionTree active branch and recalculates the token estimate.
    this.conversation.setMessages([...msgs]);

    // Reset state machine to idle so the next query starts fresh
    if (this.stateMachine.currentState !== 'idle') {
      this.stateMachine.forceTransitionTo('idle');
    }

    logger.query.info(`[QueryEngine] Session restored: ${snapshot.sessionId}, ${msgs.length} messages, turnCount=${snapshot.state.turnCount}`);
    return snapshot.state.turnCount;
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

  /** Get the budget enforcer (for testing and UI). */
  getBudgetEnforcer(): BudgetEnforcer {
    return this.budgetEnforcer;
  }

  /** Get tracked modified files */
  getModifiedFiles(): string[] {
    return Array.from(this.modifiedFiles);
  }
}
