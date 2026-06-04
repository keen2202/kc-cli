import { logger } from '../services/logger';
// Query Engine - Refactored with state machine pattern
// Inspired by OpenHarness's query loop architecture
// Sub-modules (ConversationState, CompactionHandler, MemoryHandler, ErrorHandler)
// handle specific phases to keep QueryEngine as a facade.

import type { ChatMessage, StreamEvent, AssistantMessage, ToolCall, ToolResult } from '../types/message';
import type { ToolDefinition, ToolUseContext } from '../types/tools';
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
import { CacheMetrics } from '../services/cacheMetrics';
import { CachePrefixService, buildCacheStrategy } from '../services/cachePrefix';

// Sub-modules
import { ConversationState } from './QueryEngineState';
import { CompactionHandler } from './QueryEngineCompaction';
import { MemoryHandler } from './QueryEngineMemory';
import { ErrorHandler } from './QueryEngineError';
import { estimateMessageTokensArray } from '../utils/tokenEstimation';

import { v4 as uuidv4 } from 'uuid';

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
  private cacheMetrics = new CacheMetrics();

  // Cache prefix service for byte-stable prompt prefixes
  private cachePrefix: CachePrefixService;

  // Dual-queue steering system
  private steerQueue: ChatMessage[] = [];
  private followUpQueue: ChatMessage[] = [];
  private steeringEnabled = true;

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
  }

  /**
   * Update the API key at runtime (e.g., from /key command).
   * Recreates the API client with the new key.
   */
  setApiKey(apiKey: string): void {
    this.config.apiKey = apiKey;
    this.apiClient = createAPIClient({
      provider: this.config.provider,
      apiKey,
      baseUrl: this.config.apiBaseUrl,
      model: this.config.model,
    });
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
      const maxTurns = this.config.maxTurns;

      while (!this.stateMachine.isTerminal()) {
        const currentState = this.stateMachine.currentState;

        switch (currentState) {
          case 'idle':
            this.stateMachine.transitionTo('compacting');
            break;

          case 'compacting':
            yield* this.compactingPhase();
            this.stateMachine.transitionTo('streaming');
            break;

          case 'streaming':
            yield* this.streamingPhase();
            turnCount++;
            if (turnCount >= maxTurns) {
              logger.query.warn(`[QueryEngine] Max turns (${maxTurns}) reached, forcing completion`);
              yield this.createTextDeltaEvent(`\n[Reached maximum turn limit (${maxTurns}) — stopping]\n`);
            }
            this.stateMachine.transitionTo('deciding');
            break;

          case 'deciding':
            const hasTools = turnCount >= maxTurns ? false : await this.decidingPhase();
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
                  this.stateMachine.forceTransitionTo('evolving');
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
   */
  private async *compactingPhase(): AsyncGenerator<StreamEvent | AgentEvent> {
    const config = {
      contextWindow: this.config.contextWindow || 200_000,
      model: this.config.model,
      systemPrompt: this.config.systemPrompt,
    };

    if (!this.compaction.shouldAttemptCompaction(this.conversation.getMessages(), config)) {
      return;
    }

    const result = yield* this.compaction.compact(
      this.conversation.getMessages(),
      this.apiClient,
      config
    );

    // If compaction modified messages, update conversation state
    if ('messages' in result) {
      this.conversation.setMessages(result.messages);
    }
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
        logger.query.warn(`[QueryEngine] LLM stream timed out after ${streamTimeoutMs / 1000}s, continuing with partial response`);
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

  private async decidingPhase(): Promise<boolean> {
    const lastMsg = this.conversation.getLastMessage();
    if (!lastMsg || lastMsg.role !== 'assistant') return false;

    const assistantMsg = lastMsg as AssistantMessage;
    return !!(assistantMsg.toolCalls && assistantMsg.toolCalls.length > 0);
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

      if (result instanceof Error) {
        yield this.createToolFailedEvent(toolCall, result);
      } else if (result.isError) {
        yield this.createToolFailedEvent(toolCall, new Error(result.output));
      } else {
        yield this.createToolCompletedEvent(toolCall, result as ToolResult);
      }

      // Add tool result as message
      const toolResultMsg: ChatMessage = {
        id: uuidv4(),
        role: 'tool',
        content: result instanceof Error ? result.message : (result as ToolResult).output,
        toolResults: [result instanceof Error ? { output: result.message, isError: true } : result as ToolResult],
        timestamp: Date.now(),
      };
      this.conversation.addMessage(toolResultMsg);
    }
  }

  private buildApiMessages(): ChatMessage[] {
    const messages = this.conversation.getMessagesCopy();
    const systemMsg = messages.find(m => m.role === 'system');
    const userMsgs = messages.filter(m => m.role !== 'system');

    return systemMsg ? [systemMsg, ...userMsgs] : userMsgs;
  }

  private createToolContext(): ToolUseContext {
    return {
      cwd: getState().cwd,
      abortController: this.abortController,
      permissions: buildPermissionContext(),
      sandbox: this.toolExecutor.getSandboxManager(),
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
    this.abortController = new AbortController();
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
}
