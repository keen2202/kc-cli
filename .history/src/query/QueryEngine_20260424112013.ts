// Query Engine - Refactored with state machine pattern
// Inspired by OpenHarness's query loop architecture

import type { ChatMessage, StreamEvent, AssistantMessage, ToolCall, ToolResult } from '../types/message';
import type { ToolDefinition, ToolUseContext } from '../types/tools';
import { AgentStateMachine } from '../state/machine';
import { ObservableStateStore, createInitialState } from '../state/store';
import { ToolExecutor } from '../executors/toolExecutor';
import { shouldCompact, microcompact, MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES, CompactConfig } from '../services/compaction';
import { estimateMessageTokensArray } from '../utils/tokenEstimation';
import type { AgentEvent, TokenUsage } from '../state/types';
import { hasPermissionsToUseTool } from '../permissions/engine';
import { getState } from '../bootstrap/state';
import { createAPIClient, LLMProvider } from '../api';
import type { BaseApiClient, LLMStreamEvent as APIStreamEvent, LLMRequestConfig } from '../api';
import { MemoryIntegration, createMemoryIntegration } from '../memory/integration';
import type { MemoryIntegrationConfig } from '../memory/integration';

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

  // Services
  private toolExecutor: ToolExecutor;
  private compactFailureCount = 0;

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
      apiKey: config.apiKey || process.env.CC_API_KEY || '',
      baseUrl: config.apiBaseUrl,
      model: config.model,
    });

    // Initialize state store
    this.stateStore = new ObservableStateStore(createInitialState({
      model: config.model,
      provider: config.provider,
      maxTurns: config.maxTurns,
      maxBudgetUsd: config.maxBudgetUsd,
    }));

    // Initialize state machine
    this.stateMachine = new AgentStateMachine(this.stateStore);

    // Initialize tool executor with permission config
    this.toolExecutor = new ToolExecutor(tools, getState().cwd, {
      alwaysDenyRules: [], // TODO: Load from config
      alwaysAskRules: [],  // TODO: Load from config
      alwaysAllowRules: [], // TODO: Load from config
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
      // Try microcompact first (cheap, no LLM)
      const result = microcompact(this.messages);

      if (result.wasCompacted) {
        this.messages = result.messages;
        yield this.createCompactMicroEvent(result.tokensSaved);

        // Update cached estimate
        this.cachedTokenEstimate = estimateMessageTokensArray(this.messages);

        // Check if microcompact was sufficient
        if (this.cachedTokenEstimate < threshold) {
          return;
        }
      }

      // Full compact would require LLM API integration
      // For now, we just use microcompact
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
   */
  private async *streamingPhase(): AsyncGenerator<StreamEvent | AgentEvent> {
    // Build API request
    const apiMessages = this.buildApiMessages();
    const toolsDef = this.toolExecutor.getRegisteredTools().map(toolName => {
      const tool = this.toolExecutor.getTool(toolName);
      return tool;
    }).filter((t): t is ToolDefinition => t !== undefined);

    // Call LLM with streaming
    const requestConfig: LLMRequestConfig = {
      model: this.config.model,
      messages: apiMessages,
      tools: toolsDef,
      systemPrompt: this.config.systemPrompt,
      stream: true,
      abortSignal: this.abortController.signal,
    };

    // Stream response
    let fullContent = '';
    const toolCalls: ToolCall[] = [];

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

      yield this.createTurnCompleteEvent(assistantMsg);
    } catch (error) {
      yield this.createErrorEvent(error instanceof Error ? error : new Error(String(error)));
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

    // Create tool execution context
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
   * Abort current query
   */
  abort(): void {
    this.abortController.abort();
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
   * Enforce message history limit to prevent unbounded memory growth.
   * Removes oldest messages when limit is exceeded.
   */
  private trimMessages(): void {
    const maxMessages = this.config.maxMessages ?? QueryEngine.DEFAULT_MAX_MESSAGES;

    if (this.messages.length > maxMessages) {
      // Remove oldest messages, keep most recent
      const excess = this.messages.length - maxMessages + QueryEngine.MESSAGE_TRIM_COUNT;
      this.messages = this.messages.slice(excess);

      // Invalidate cached estimate after trim
      this.cachedTokenEstimate = null;

      console.warn(`[QueryEngine] Message history exceeded ${maxMessages} limit, trimmed ${excess} messages`);
    }
  }
}
