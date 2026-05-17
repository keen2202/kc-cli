// Query Engine - Refactored with state machine pattern
// Inspired by OpenHarness's query loop architecture

import type { ChatMessage, StreamEvent, AssistantMessage, ToolCall, ToolResult } from '../types/message';
import type { ToolDefinition, ToolUseContext } from '../types/tools';
import { AgentStateMachine } from '../state/machine';
import { ObservableStateStore, createInitialState } from '../state/store';
import { ToolExecutor } from '../executors/toolExecutor';
import { shouldCompact, microcompact, fullCompact, MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES, CompactConfig } from '../services/compaction';
import { estimateMessageTokensArray } from '../utils/tokenEstimation';
import type { AgentEvent, TokenUsage } from '../state/types';
import { hasPermissionsToUseTool } from '../permissions/engine';
import { getState } from '../bootstrap/state';
import { createAPIClient, LLMProvider } from '../api';
import type { BaseApiClient, LLMStreamEvent as APIStreamEvent, LLMRequestConfig } from '../api';
import { MemoryIntegration, createMemoryIntegration } from '../memory/integration';
import type { MemoryIntegrationConfig } from '../memory/integration';
import { classifyApiError, getRetryDelay, RetryState } from '../services/error-classifier';
import { CircuitBreakerRegistry } from '../services/circuitBreaker';
import { StateValidator } from '../services/stateValidator';
import { UserProfileService } from '../services/userProfile';
import { getSystemPromptAdaptation, getToolHints } from '../services/behavioralAdapter';

import { v4 as uuidv4 } from 'uuid';

export interface QueryEngineConfig {
  model: string;
  provider: LLMProvider;
  apiKey?: string;
  apiBaseUrl?: string;
  maxTurns: number;
  maxBudgetUsd: number | null;
  systemPrompt?: string;
  contextWindow?: number; // For auto-compaction
  maxMessages?: number; // Max messages to keep in history (prevents unbounded growth)
  memory?: MemoryIntegrationConfig; // Memory system configuration
  permissionRules?: {
    deny?: string[];
    ask?: string[];
    allow?: string[];
  };
}

/**
 * Query Engine with explicit state machine pattern.
 * Manages the full query lifecycle through distinct phases:
 * idle → compacting → streaming → deciding → executing → (loop or complete)
 */
export class QueryEngine {
  // State management
  private stateStore: ObservableStateStore;
  private stateMachine: AgentStateMachine;

  // LLM API Client
  private apiClient: BaseApiClient;

  // Memory Integration
  private memoryIntegration: MemoryIntegration;

  // Services
  private toolExecutor: ToolExecutor;
  private compactFailureCount = 0;
  private retryState = new RetryState();
  private circuitBreakers = new CircuitBreakerRegistry();
  private stateValidator = new StateValidator();
  private userProfile: UserProfileService;

  // Conversation state
  private messages: ChatMessage[] = [];
  private config: QueryEngineConfig;
  private abortController: AbortController;

  // Performance: cached token estimate
  private cachedTokenEstimate: number | null = null;

  // Constants
  private static readonly DEFAULT_MAX_MESSAGES = 1000; // Hard limit to prevent memory exhaustion
  private static readonly MESSAGE_TRIM_COUNT = 100; // Messages to remove when limit hit

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

    // Initialize memory integration
    this.memoryIntegration = createMemoryIntegration(
      config.memory || {}
    );

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
    this.messages.push(userMsg);

    // Performance: invalidate token cache
    this.cachedTokenEstimate = null;

    // Enforce message limit to prevent unbounded memory growth
    this.trimMessages();

    // State machine loop
    try {
      while (!this.stateMachine.isTerminal()) {
        const currentState = this.stateMachine.currentState;

        switch (currentState) {
          case 'idle':
            // Transition to compacting phase
            this.stateMachine.transitionTo('compacting');
            break;

          case 'compacting':
            yield* this.compactingPhase();
            this.stateMachine.transitionTo('streaming');
            break;

          case 'streaming':
            yield* this.streamingPhase();
            this.stateMachine.transitionTo('deciding');
            break;

          case 'deciding':
            const hasTools = await this.decidingPhase();
            if (hasTools) {
              this.stateMachine.transitionTo('executing');
            } else {
              this.stateMachine.transitionTo('completed');
              yield this.createCompleteEvent();
            }
            break;

          case 'executing':
            yield* this.executingPhase();
            // After execution, loop back to streaming
            if (!this.stateMachine.isTerminal()) {
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
      yield this.createErrorEvent(error);
    }
  }

  /**
   * Phase 1: Auto-compaction check
   * Optimization: Uses cached token estimate to avoid redundant calculations.
   * Includes retry for transient API errors during full compaction.
   */
  private async *compactingPhase(): AsyncGenerator<StreamEvent | AgentEvent> {
    const config: CompactConfig = {
      contextWindow: this.config.contextWindow || 200_000,
      model: this.config.model,
    };

    // Use cached estimate or calculate
    const tokenCount = this.cachedTokenEstimate ?? estimateMessageTokensArray(this.messages);
    this.cachedTokenEstimate = tokenCount;

    const threshold = config.contextWindow - 20_000 - 13_000;
    if (tokenCount < threshold || this.compactFailureCount >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES) {
      return;
    }

    try {
      // Validate state before compaction
      const validation = this.stateValidator.validate(this.messages);
      if (!validation.valid) {
        console.warn(`State validation found ${validation.issues.length} issues before compaction, repairing...`);
        this.messages = this.stateValidator.repair(this.messages, validation.issues);
        this.cachedTokenEstimate = null; // Invalidate cache after repair
      }

      // Try microcompact first (cheap, no LLM)
      const result = microcompact(this.messages);

      if (result.wasCompacted) {
        this.messages = result.messages;
        yield this.createCompactMicroEvent(result.tokensSaved);

        // Update cached estimate
        this.cachedTokenEstimate = estimateMessageTokensArray(this.messages);

        // Check if microcompact was sufficient
        if (this.cachedTokenEstimate < threshold) {
          this.compactFailureCount = 0;
          return;
        }
      }

      // Full LLM-based compaction with retry
      const maxCompactionRetries = 2;
      let fullResult: { wasCompacted: boolean; messages: ChatMessage[]; tokensSaved: number } | null = null;

      for (let retryAttempt = 0; retryAttempt <= maxCompactionRetries; retryAttempt++) {
        try {
          const { fullCompact } = await import('../services/compaction');
          fullResult = await fullCompact(
            this.messages,
            this.apiClient,
            config,
            this.config.systemPrompt
          );
          break; // Success, exit retry loop
        } catch (compactError) {
          const err = compactError instanceof Error ? compactError : new Error(String(compactError));
          const classified = classifyApiError(err);

          if (classified.retryable && retryAttempt < maxCompactionRetries) {
            const delay = classified.retryAfterMs ?? getRetryDelay(retryAttempt);
            console.warn(`Compaction retry ${retryAttempt + 1}/${maxCompactionRetries} after ${delay}ms: ${err.message}`);
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }

          throw compactError; // Re-throw if not retryable or retries exhausted
        }
      }

      if (fullResult && fullResult.wasCompacted) {
        this.messages = fullResult.messages;
        this.cachedTokenEstimate = estimateMessageTokensArray(this.messages);
        yield this.createCompactFullEvent(
          estimateMessageTokensArray(this.messages) + fullResult.tokensSaved,
          this.cachedTokenEstimate
        );
      }

      this.compactFailureCount = 0;
    } catch (error) {
      this.compactFailureCount++;
      if (this.compactFailureCount >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES) {
        console.warn('Auto-compaction disabled after repeated failures');
      }
    }
  }

  /**
   * Phase 2: Stream response from LLM
   * Uses loop-based retry to prevent stack overflow
   */
  private async *streamingPhase(): AsyncGenerator<StreamEvent | AgentEvent> {
    const maxRetries = 3;

    for (let retryAttempt = 0; retryAttempt <= maxRetries; retryAttempt++) {
      // Build API request
      const apiMessages = this.buildApiMessages();
      const toolsDef = this.toolExecutor.getRegisteredTools().map(toolName => {
        const tool = this.toolExecutor.getTool(toolName);
        return tool;
      }).filter((t): t is ToolDefinition => t !== undefined);

      // Get last user message for memory lookup
      const lastUserMessage = [...this.messages].reverse().find(m => m.role === 'user');

      // Load relevant memories (pre-query)
      let memoryContext = '';
      if (lastUserMessage && this.memoryIntegration.isEnabled()) {
        const recentTools = toolsDef.slice(0, 5).map(t => t.name);
        memoryContext = await this.memoryIntegration.loadRelevantMemories(
          lastUserMessage.content || '',
          recentTools
        );
      }

      // Build system prompt with memory context and level adaptation
      const level = this.userProfile.getLevel();
      const levelAdaptation = getSystemPromptAdaptation(level, toolsDef);
      let systemPrompt = this.config.systemPrompt || '';
      if (levelAdaptation) {
        systemPrompt += levelAdaptation;
      }
      if (memoryContext) {
        systemPrompt += `\n\n${memoryContext}`;
      }

      // Call LLM with streaming
      const requestConfig: LLMRequestConfig = {
        model: this.config.model,
        messages: apiMessages,
        tools: toolsDef,
        systemPrompt,
        stream: true,
        abortSignal: this.abortController.signal,
      };

      // Stream response
      let fullContent = '';
      const toolCalls: ToolCall[] = [];

      // Check circuit breaker before making API call
      const apiBreaker = this.circuitBreakers.getBreaker('api');
      if (!apiBreaker.canExecute()) {
        console.warn(`API circuit breaker is ${apiBreaker.getState()}, skipping request`);
        yield this.createErrorEvent(new Error(`API service is temporarily unavailable (circuit breaker ${apiBreaker.getState()})`));
        return;
      }

      try {
        for await (const event of this.apiClient.streamChat(requestConfig)) {
          if (event.type === 'text_delta') {
            fullContent += event.text || '';
            yield this.createTextDeltaEvent(event.text || '');
          } else if (event.type === 'tool_use') {
            if (event.toolCall) {
              toolCalls.push(event.toolCall);
              yield this.createToolStartedEvent(event.toolCall);
            }
          } else if (event.type === 'error') {
            yield this.createErrorEvent(event.error || new Error('Unknown error'));
            return;
          } else if (event.type === 'stop') {
            // Stream complete
            break;
          }
        }

        // Add assistant message
        const assistantMsg: AssistantMessage = {
          id: uuidv4(),
          role: 'assistant',
          content: fullContent || null,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          timestamp: Date.now(),
        };
        this.messages.push(assistantMsg);

        // Update state
        this.stateStore.incrementTurn();

        // Reset retry counter on success
        this.retryState.reset('streaming');

        // Record success with circuit breaker
        apiBreaker.recordSuccess();

        yield this.createTurnCompleteEvent(assistantMsg);
        return; // Success, exit retry loop
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        const classified = classifyApiError(err);

        // Record failure with circuit breaker for transient errors
        if (classified.retryable) {
          apiBreaker.recordFailure();
        }

        // Handle degraded errors: log warning and continue without retrying
        if (classified.errorClass === 'degraded') {
          console.warn(`Degraded error in streaming: ${err.message}`);
          return;
        }

        // Check if we can retry
        if (classified.retryable && retryAttempt < maxRetries) {
          const delay = classified.retryAfterMs ?? getRetryDelay(retryAttempt);
          yield this.createErrorEvent(new Error(`Retrying (${retryAttempt + 1}/${maxRetries}) after ${classified.context}: ${err.message}`));
          await new Promise(resolve => setTimeout(resolve, delay));
          continue; // Loop-based retry
        }

        // Final failure
        this.retryState.reset('streaming');
        yield this.createErrorEvent(err);
        return;
      }
    }
  }

  /**
   * Phase 3: Decide whether to execute tools or complete
   */
  private async decidingPhase(): Promise<boolean> {
    const lastMessage = this.messages[this.messages.length - 1];

    // Check for tool calls
    if (lastMessage?.role === 'assistant' && lastMessage.toolCalls && lastMessage.toolCalls.length > 0) {
      return true;
    }

    return false;
  }

  /**
   * Phase 4: Execute tool calls (single or parallel)
   */
  private async *executingPhase(): AsyncGenerator<StreamEvent | AgentEvent> {
    const lastMessage = this.messages[this.messages.length - 1] as AssistantMessage;
    const toolCalls = lastMessage?.toolCalls || [];

    if (toolCalls.length === 0) {
      return;
    }

    // Tool execution context. Permission decisions are made by
    // ToolExecutor.checkPermission() using ToolExecutor.permissionConfig
    // (populated from the same config at construction time). The arrays
    // below are empty because this context object's permission fields
    // are not used for authorization; they exist for interface compliance.
    const context: ToolUseContext = {
      cwd: getState().cwd,
      abortController: this.abortController,
      permissions: {
        mode: getState().permissionMode,
        cwd: getState().cwd,
        toolName: '',
        input: {},
        alwaysDenyRules: [],
        alwaysAskRules: [],
        alwaysAllowRules: [],
        bypassPermissions: getState().permissionMode === 'bypassPermissions',
      },
    };

    if (toolCalls.length === 1) {
      // Single tool - sequential execution
      const toolCall = toolCalls[0];
      yield this.createToolStartedEvent(toolCall);

      const result = await this.toolExecutor.executeSingle(toolCall, context);

      if (result.isError) {
        yield this.createToolFailedEvent(toolCall, new Error(result.output));
      } else {
        yield this.createToolCompletedEvent(toolCall, result);
      }

      // Level-based tool hints
      const level = this.userProfile.getLevel();
      const hint = getToolHints(toolCall.toolName, level, !result.isError);
      if (hint) {
        yield this.createToolHintEvent(toolCall.toolName, hint.hint);
      }

      // Add tool result to messages
      this.messages.push({
        id: uuidv4(),
        role: 'tool',
        content: null,
        toolResults: [result],
        timestamp: Date.now(),
      });
    } else {
      // Multiple tools - parallel execution
      // Emit started events for all
      for (const toolCall of toolCalls) {
        yield this.createToolStartedEvent(toolCall);
      }

      // Execute in parallel
      const results = await this.toolExecutor.executeParallel(toolCalls, context);

      // Emit completion events and build results array
      const toolResults: ToolResult[] = [];

      for (const toolCall of toolCalls) {
        const result = results.get(toolCall.id);

        if (!result) {
          continue;
        }

        if (result instanceof Error) {
          yield this.createToolFailedEvent(toolCall, result);
          toolResults.push({
            toolCallId: toolCall.id,
            output: result.message,
            isError: true,
          });
        } else {
          if (result.isError) {
            yield this.createToolFailedEvent(toolCall, new Error(result.output));
          } else {
            yield this.createToolCompletedEvent(toolCall, result);
          }
          toolResults.push(result);
        }
      }

      // Add all tool results to messages
      this.messages.push({
        id: uuidv4(),
        role: 'tool',
        content: null,
        toolResults,
        timestamp: Date.now(),
      });
    }
  }

  // ========== Event Creation Helpers ==========

  private createTextDeltaEvent(text: string): AgentEvent {
    return {
      type: 'agent:text_delta',
      text,
      timestamp: Date.now(),
    };
  }

  private createTurnCompleteEvent(message: AssistantMessage): AgentEvent {
    const usage: TokenUsage = {
      inputTokens: 0, // Would calculate from messages
      outputTokens: 0,
      totalTokens: 0,
    };

    return {
      type: 'agent:turn_complete',
      message,
      usage,
      timestamp: Date.now(),
    };
  }

  private createToolStartedEvent(toolCall: ToolCall): AgentEvent {
    return {
      type: 'agent:tool_started',
      toolCall,
      timestamp: Date.now(),
    };
  }

  private createToolCompletedEvent(toolCall: ToolCall, result: ToolResult): AgentEvent {
    return {
      type: 'agent:tool_completed',
      toolCall,
      result,
      timestamp: Date.now(),
    };
  }

  private createToolFailedEvent(toolCall: ToolCall, error: Error): AgentEvent {
    return {
      type: 'agent:tool_failed',
      toolCall,
      error,
      timestamp: Date.now(),
    };
  }

  private createToolPermissionDeniedEvent(toolCall: ToolCall, reason: string): AgentEvent {
    return {
      type: 'agent:tool_permission_denied',
      toolCall,
      reason,
      timestamp: Date.now(),
    };
  }

  private createCompactMicroEvent(tokensSaved: number): AgentEvent {
    return {
      type: 'agent:compact_micro',
      tokensSaved,
      timestamp: Date.now(),
    };
  }

  private createCompactFullEvent(originalTokens: number, compactedTokens: number): AgentEvent {
    return {
      type: 'agent:compact_full',
      originalTokens,
      compactedTokens,
      timestamp: Date.now(),
    };
  }

  private createErrorEvent(error: unknown): AgentEvent {
    return {
      type: 'agent:error',
      error: error instanceof Error ? error : new Error(String(error)),
      recoverable: false,
      timestamp: Date.now(),
    };
  }

  private createCompleteEvent(): AgentEvent {
    return {
      type: 'agent:complete',
      timestamp: Date.now(),
    };
  }

  private createToolHintEvent(toolName: string, hint: string): AgentEvent {
    return {
      type: 'agent:tool_hint',
      toolName,
      hint,
      timestamp: Date.now(),
    };
  }

  // ========== Legacy Methods (for backward compatibility) ==========

  /**
   * Build messages for API call
   */
  private buildApiMessages(): any[] {
    const messages: any[] = [];

    if (this.config.systemPrompt) {
      messages.push({
        role: 'system',
        content: this.config.systemPrompt,
      });
    }

    for (const msg of this.messages) {
      if (msg.role === 'user') {
        messages.push({
          role: 'user',
          content: msg.content,
        });
      } else if (msg.role === 'assistant') {
        messages.push({
          role: 'assistant',
          content: msg.content,
          tool_calls: msg.toolCalls?.map(tc => ({
            id: tc.id,
            type: 'function',
            function: {
              name: tc.toolName,
              arguments: JSON.stringify(tc.input),
            },
          })),
        });
      } else if (msg.role === 'tool') {
        for (const result of msg.toolResults || []) {
          messages.push({
            role: 'tool',
            tool_call_id: result.toolCallId,
            content: result.output,
          });
        }
      }
    }

    return messages;
  }

  /**
   * Get conversation history
   */
  getMessages(): ChatMessage[] {
    return [...this.messages];
  }

  /**
   * Clear conversation
   */
  clear(): void {
    this.messages = [];
    this.stateMachine.reset();
  }

  /**
   * Get state store for observation
   */
  getStateStore(): ObservableStateStore {
    return this.stateStore;
  }

  /**
   * Get state machine for inspection
   */
  getStateMachine(): AgentStateMachine {
    return this.stateMachine;
  }

  /**
   * Get memory integration instance
   */
  getMemoryIntegration(): MemoryIntegration {
    return this.memoryIntegration;
  }

  /**
   * Abort the current query
   */
  abort(reason?: string): void {
    this.abortController.abort(reason);
  }

  /**
   * Check if the query has been aborted
   */
  isAborted(): boolean {
    return this.abortController.signal.aborted;
  }

  /**
   * Enforce message history limit to prevent unbounded memory growth.
   * Removes oldest messages when limit is exceeded.
   */
  /**
   * Trim messages to stay within the max limit.
   * Protects anchor messages (system prompt + first user message) from being trimmed.
   */
  private trimMessages(): void {
    const maxMessages = this.config.maxMessages ?? QueryEngine.DEFAULT_MAX_MESSAGES;

    if (this.messages.length <= maxMessages) {
      return;
    }

    // Find anchor indices: system prompt and first user message
    const anchorIndices = new Set<number>();
    for (let i = 0; i < this.messages.length; i++) {
      if (this.messages[i].role === 'system') {
        anchorIndices.add(i);
        break; // Only the first system message is an anchor
      }
    }
    for (let i = 0; i < this.messages.length; i++) {
      if (this.messages[i].role === 'user') {
        anchorIndices.add(i);
        break; // Only the first user message is an anchor
      }
    }

    const excess = this.messages.length - maxMessages;

    if (anchorIndices.size === 0) {
      // No anchors, trim from the front
      this.messages = this.messages.slice(excess);
    } else {
      // Trim non-anchor messages from oldest first, skipping anchors
      const toRemove = new Set<number>();
      let removed = 0;

      for (let i = 0; i < this.messages.length && removed < excess; i++) {
        if (!anchorIndices.has(i)) {
          toRemove.add(i);
          removed++;
        }
      }

      // If we couldn't remove enough non-anchor messages, we have to trim anyway
      // (this shouldn't happen in practice as anchors are at the start)
      if (removed < excess) {
        this.messages = this.messages.slice(excess);
      } else {
        this.messages = this.messages.filter((_, idx) => !toRemove.has(idx));
      }
    }

    // Invalidate cached estimate after trim
    this.cachedTokenEstimate = null;

    console.warn(`[QueryEngine] Message history exceeded ${maxMessages} limit, trimmed ${excess} messages`);
  }
}
