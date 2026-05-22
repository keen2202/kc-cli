// Tool executor - handles single and parallel tool execution with permission checks

import type { ToolCall, ToolResult } from '../types/message';
import type { ToolDefinition, ToolUseContext } from '../types/tools';
import type { PermissionResult } from '../types/permissions';
import type { ToolExecutionState } from '../state/types';
import type { PluginHooks } from '../plugins/types';
import { hasPermissionsToUseTool } from '../permissions/engine';
import { SandboxManager } from '../services/sandbox';
import { mergeSandboxPolicy } from '../services/sandbox-policy';

/**
 * Symbol used to mark tool input that has already had its command
 * wrapped by the executor's sandbox. Tools check for this marker
 * to avoid double-wrapping.
 */
export const SANDBOX_WRAPPED_MARKER = Symbol.for('kc-cli.sandbox-wrapped');

/**
 * Tool names whose input contains a `command` field that must be
 * sandbox-wrapped at the executor level to prevent tools from
 * accidentally or intentionally bypassing sandbox policy.
 */
const COMMAND_EXECUTING_TOOLS = new Set(['Bash', 'Run']);

/**
 * Tool executor that supports both sequential and parallel tool execution
 * with timeout protection and sandbox isolation to prevent infinite hangs.
 */
export class ToolExecutor {
  private tools: Map<string, ToolDefinition>;
  private cachedToolNames: string[]; // Cached since tools don't change after construction
  private cwd: string;
  private permissionConfig?: {
    alwaysDenyRules?: string[];
    alwaysAskRules?: string[];
    alwaysAllowRules?: string[];
  };
  private pluginHooks?: PluginHooks;
  private sandboxManager: SandboxManager;
  private readonly DEFAULT_TIMEOUT_MS = 30_000; // 30 seconds

  constructor(
    tools: ToolDefinition[],
    cwd: string,
    permissionConfig?: {
      alwaysDenyRules?: string[];
      alwaysAskRules?: string[];
      alwaysAllowRules?: string[];
    },
    pluginHooks?: PluginHooks,
    sandboxOptions?: {
      enabled?: boolean;
      backend?: 'bubblewrap' | 'seccomp' | 'docker' | 'noop';
      allowNetwork?: boolean;
      maxMemoryMb?: number;
      cpuTimeLimitSec?: number;
      policy?: Parameters<typeof mergeSandboxPolicy>[0];
    }
  ) {
    this.tools = new Map(tools.map(tool => [tool.name, tool]));
    this.cachedToolNames = Array.from(this.tools.keys());
    this.cwd = cwd;
    this.permissionConfig = permissionConfig;
    this.pluginHooks = pluginHooks;

    // Initialize sandbox manager with config
    const policy = sandboxOptions?.policy ? mergeSandboxPolicy(sandboxOptions.policy) : undefined;
    this.sandboxManager = new SandboxManager({
      workDir: cwd,
      enabled: sandboxOptions?.enabled ?? true,
      backend: sandboxOptions?.backend ?? 'bubblewrap',
      allowNetwork: sandboxOptions?.allowNetwork ?? false,
      maxMemoryMb: sandboxOptions?.maxMemoryMb ?? 512,
      cpuTimeLimitSec: sandboxOptions?.cpuTimeLimitSec ?? 60,
      policy,
    });
  }

  /**
   * Execute a single tool call with timeout protection
   */
  async executeSingle(
    toolCall: ToolCall,
    context: ToolUseContext
  ): Promise<ToolResult> {
    const startTime = Date.now();

    try {
      // 1. Find tool
      const tool = this.tools.get(toolCall.toolName);
      if (!tool) {
        return {
          toolCallId: toolCall.id,
          output: `Unknown tool: ${toolCall.toolName}`,
          isError: true,
        };
      }

      // 2. Plugin preToolUse hook (may modify input)
      let effectiveInput = toolCall.input;
      if (this.pluginHooks?.preToolUse) {
        try {
          const modifiedInput = await this.pluginHooks.preToolUse(toolCall.toolName, toolCall.input, context);
          if (modifiedInput === null) {
            return {
              toolCallId: toolCall.id,
              output: `Tool execution blocked by plugin hook`,
              isError: true,
            };
          }
          effectiveInput = modifiedInput;
        } catch (err) {
          console.warn(`[Plugin] preToolUse hook error:`, err);
        }
      }

      // 3. Permission check
      const permissionResult = await this.checkPermission(toolCall, tool, context);
      if (permissionResult.behavior === 'deny') {
        return {
          toolCallId: toolCall.id,
          output: `Permission denied: ${permissionResult.message}`,
          isError: true,
        };
      }

      // 3b. Check sandbox requirement for command-based tools
      const sandboxDecision = this.sandboxManager.shouldSandboxTool(toolCall.toolName);
      if (sandboxDecision === 'deny') {
        return {
          toolCallId: toolCall.id,
          output: `Tool '${toolCall.toolName}' requires sandbox but no sandbox backend is available. ` +
            'Install bubblewrap (bwrap) or docker, or configure this tool as excluded.',
          isError: true,
        };
      }

      // 3c. Pre-wrap commands at the executor level for command-executing tools.
      // This is the authoritative sandbox enforcement point — tools MUST NOT
      // bypass this by creating their own SandboxManager. The wrapped command
      // is injected into input and marked to prevent double-wrapping.
      let effectiveInputWithWrap = effectiveInput;
      if (COMMAND_EXECUTING_TOOLS.has(toolCall.toolName) && sandboxDecision === 'run-sandboxed') {
        const wrappedCommand = this.sandboxManager.wrapCommand(
          (effectiveInput as Record<string, unknown>).command as string,
          toolCall.toolName
        );
        effectiveInputWithWrap = {
          ...effectiveInput,
          command: wrappedCommand,
          [SANDBOX_WRAPPED_MARKER]: true,
        } as typeof effectiveInput;
      }

      // 4. Execute tool with timeout (sandbox info passed via context)
      const timeoutMs = this.getToolTimeout(tool);
      const result = await this.executeWithTimeout(tool, effectiveInputWithWrap, context, timeoutMs, toolCall.toolName, toolCall.id);

      // 4b. Add sandbox metadata to result
      if (result.metadata) {
        result.metadata.sandboxed = this.sandboxManager.isAvailable() && sandboxDecision === 'run-sandboxed';
        result.metadata.sandboxBackend = this.sandboxManager.getBackendName();
      } else {
        result.metadata = {
          sandboxed: this.sandboxManager.isAvailable() && sandboxDecision === 'run-sandboxed',
          sandboxBackend: this.sandboxManager.getBackendName(),
        };
      }

      // 5. Plugin postToolUse hook
      if (this.pluginHooks?.postToolUse) {
        try {
          await this.pluginHooks.postToolUse(toolCall.toolName, effectiveInput, result, context);
        } catch (err) {
          console.warn(`[Plugin] postToolUse hook error:`, err);
        }
      }

      return result;
    } catch (error) {
      return {
        toolCallId: toolCall.id,
        output: `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }
  }

  /**
   * Execute tool with timeout protection using AbortSignal.
   * Returns a timeout result with the original toolCallId and timedOut flag.
   */
  private async executeWithTimeout(
    tool: ToolDefinition,
    input: Record<string, unknown>,
    context: ToolUseContext,
    timeoutMs: number,
    toolName: string,
    toolCallId?: string
  ): Promise<ToolResult> {
    // Create abort controller for this tool execution
    const toolAbortController = new AbortController();

    // Merge with parent abort signal if available
    if (context.abortController?.signal) {
      context.abortController.signal.addEventListener('abort', () => {
        toolAbortController.abort(context.abortController?.signal.reason);
      }, { once: true });
    }

    // Timeout promise - rejects after timeoutMs
    const timeoutError = new Error(`Tool '${toolName}' timed out after ${timeoutMs / 1000}s`);
    let timedOut = false;
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        timedOut = true;
        toolAbortController.abort(timeoutError);
        reject(timeoutError);
      }, timeoutMs);
    });

    // Create tool execution promise with abort signal and sandbox
    const execPromise = tool.call(input, {
      ...context,
      abortController: toolAbortController,
      sandbox: this.sandboxManager,
    });

    // Race between timeout and execution
    try {
      const result = await Promise.race([execPromise, timeoutPromise]);
      if (toolAbortController.signal.aborted) {
        throw timeoutError;
      }
      const toolResult = result as ToolResult;
      return {
        toolCallId: toolCallId || '',
        output: toolResult.output ?? '',
        isError: toolResult.isError || false,
      };
    } catch (error) {
      if (timedOut) {
        return {
          toolCallId: toolCallId || '',
          output: `Tool '${toolName}' timed out after ${timeoutMs / 1000}s`,
          isError: true,
          timedOut: true,
        };
      }
      throw error;
    }
  }

  /**
   * Get timeout for a specific tool (uses tool's metadata or default)
   */
  private getToolTimeout(tool: ToolDefinition): number {
    // Check if tool has a custom timeout in its metadata
    const timeout = tool.timeout;
    if (typeof timeout === 'number' && timeout > 0) {
      return timeout * 1000; // Convert seconds to ms
    }
    return this.DEFAULT_TIMEOUT_MS;
  }

  /**
   * Execute multiple tool calls in parallel
   * Respects concurrency safety flags per tool
   */
  async executeParallel(
    toolCalls: ToolCall[],
    context: ToolUseContext
  ): Promise<Map<string, ToolResult | Error>> {
    const results = new Map<string, ToolResult | Error>();

    // Enrich context with sandbox manager
    const enrichedContext: ToolUseContext = {
      ...context,
      sandbox: this.sandboxManager,
    };

    // Group tools by concurrency safety
    const concurrentTools: ToolCall[] = [];
    const sequentialTools: ToolCall[] = [];

    for (const toolCall of toolCalls) {
      const tool = this.tools.get(toolCall.toolName);
      if (tool?.isConcurrencySafe?.(toolCall.input) !== false) {
        concurrentTools.push(toolCall);
      } else {
        sequentialTools.push(toolCall);
      }
    }

    // Execute concurrent tools in parallel
    if (concurrentTools.length > 0) {
      const promises = concurrentTools.map(async (toolCall) => {
        try {
          const result = await this.executeSingle(toolCall, enrichedContext);
          return { toolCallId: toolCall.id, result };
        } catch (error) {
          return {
            toolCallId: toolCall.id,
            error: error instanceof Error ? error : new Error(String(error)),
          };
        }
      });

      const settled = await Promise.allSettled(promises);

      for (const result of settled) {
        if (result.status === 'fulfilled') {
          if ('error' in result.value && result.value.error) {
            results.set(result.value.toolCallId, result.value.error);
          } else {
            results.set(result.value.toolCallId, result.value.result);
          }
        }
      }
    }

    // Execute sequential tools one by one
    for (const toolCall of sequentialTools) {
      try {
        const result = await this.executeSingle(toolCall, enrichedContext);
        results.set(toolCall.id, result);
      } catch (error) {
        results.set(
          toolCall.id,
          error instanceof Error ? error : new Error(String(error))
        );
      }
    }

    return results;
  }

  /**
   * Extract content string from tool input for permission matching
   */
  private extractContentForPermission(toolName: string, input: Record<string, unknown>): string | undefined {
    // Extract the most relevant string for content-based permission rules
    switch (toolName) {
      case 'Bash':
        return input.command as string;
      case 'FileRead':
      case 'FileWrite':
      case 'Glob':
      case 'Grep':
        return input.path as string;
      case 'Git':
        return input.args as string;
      default:
        return undefined;
    }
  }

  /**
   * Batch permission check for multiple tool calls
   * Returns permission results for all tools before execution
   */
  async batchPermissionCheck(
    toolCalls: ToolCall[],
    context: ToolUseContext
  ): Promise<PermissionResult[]> {
    const results: PermissionResult[] = [];

    for (const toolCall of toolCalls) {
      const tool = this.tools.get(toolCall.toolName);
      if (!tool) {
        results.push({
          behavior: 'deny',
          message: `Unknown tool: ${toolCall.toolName}`,
        });
        continue;
      }

      const permission = await hasPermissionsToUseTool(toolCall.toolName, toolCall.input, {
        // ToolDefinition.checkPermissions takes ToolUseContext but hasPermissionsToUseTool
        // expects PermissionContext; the fields are compatible at runtime.
        toolCheckPermissions: tool.checkPermissions as unknown as (input: Record<string, unknown>, context: import('../types/permissions').PermissionContext) => import('../types/permissions').PermissionResult,
        content: this.extractContentForPermission(toolCall.toolName, toolCall.input),
        config: this.permissionConfig,
      });

      results.push(permission);
    }

    return results;
  }

  /**
   * Check permission for a single tool call
   */
  private async checkPermission(
    toolCall: ToolCall,
    tool: ToolDefinition,
    context: ToolUseContext
  ): Promise<PermissionResult> {
    return await hasPermissionsToUseTool(toolCall.toolName, toolCall.input, {
      // ToolDefinition.checkPermissions takes ToolUseContext but hasPermissionsToUseTool
      // expects PermissionContext; the fields are compatible at runtime.
      toolCheckPermissions: tool.checkPermissions as unknown as (input: Record<string, unknown>, context: import('../types/permissions').PermissionContext) => import('../types/permissions').PermissionResult,
      content: this.extractContentForPermission(toolCall.toolName, toolCall.input),
      config: this.permissionConfig,
    });
  }

  /**
   * Get registered tool names
   */
  getRegisteredTools(): string[] {
    return this.cachedToolNames;
  }

  /**
   * Check if a tool is registered
   */
  hasTool(toolName: string): boolean {
    return this.tools.has(toolName);
  }

  /**
   * Get tool definition by name
   */
  getTool(toolName: string): ToolDefinition | undefined {
    return this.tools.get(toolName);
  }

  /**
   * Get the sandbox manager for inspecting sandbox state.
   */
  getSandboxManager(): SandboxManager {
    return this.sandboxManager;
  }
}
