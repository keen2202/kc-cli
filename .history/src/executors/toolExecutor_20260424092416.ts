// Tool executor - handles single and parallel tool execution with permission checks

import type { ToolCall, ToolResult } from '../types/message';
import type { ToolDefinition, ToolUseContext } from '../types/tools';
import type { PermissionResult } from '../types/permissions';
import type { ToolExecutionState } from '../state/types';
import { hasPermissionsToUseTool } from '../permissions/engine';

/**
 * Tool executor that supports both sequential and parallel tool execution
 * with timeout protection to prevent infinite hangs.
 */
export class ToolExecutor {
  private tools: Map<string, ToolDefinition>;
  private cwd: string;
  private permissionConfig?: {
    alwaysDenyRules?: string[];
    alwaysAskRules?: string[];
    alwaysAllowRules?: string[];
  };
  private readonly DEFAULT_TIMEOUT_MS = 30_000; // 30 seconds

  constructor(tools: ToolDefinition[], cwd: string, permissionConfig?: {
    alwaysDenyRules?: string[];
    alwaysAskRules?: string[];
    alwaysAllowRules?: string[];
  }) {
    this.tools = new Map(tools.map(tool => [tool.name, tool]));
    this.cwd = cwd;
    this.permissionConfig = permissionConfig;
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

      // 2. Permission check
      const permissionResult = await this.checkPermission(toolCall, tool, context);
      if (permissionResult.behavior === 'deny') {
        return {
          toolCallId: toolCall.id,
          output: `Permission denied: ${permissionResult.message}`,
          isError: true,
        };
      }

      // 3. Execute tool with timeout
      const timeoutMs = this.getToolTimeout(tool);
      const result = await this.executeWithTimeout(tool, toolCall.input, context, timeoutMs, toolCall.toolName);

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
   * Execute tool with timeout protection using AbortSignal
   */
  private async executeWithTimeout(
    tool: ToolDefinition,
    input: Record<string, unknown>,
    context: ToolUseContext,
    timeoutMs: number,
    toolName: string
  ): Promise<ToolResult> {
    const timeoutError = new Error(`Tool '${toolName}' timed out after ${timeoutMs / 1000}s`);

    // Create timeout promise
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(timeoutError), timeoutMs);
    });

    // Create tool execution promise
    const execPromise = tool.call(input, context);

    // Race between timeout and execution
    try {
      const result = await Promise.race([execPromise, timeoutPromise]);
      return {
        toolCallId: '', // Will be set by caller
        output: (result as any).output || '',
        isError: (result as any).isError || false,
      };
    } catch (error) {
      if (error === timeoutError) {
        throw error;
      }
      throw error;
    }
  }

  /**
   * Get timeout for a specific tool (uses tool's metadata or default)
   */
  private getToolTimeout(tool: ToolDefinition): number {
    // Check if tool has a custom timeout in its metadata
    const timeout = (tool as any).timeout;
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
          const result = await this.executeSingle(toolCall, context);
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
        const result = await this.executeSingle(toolCall, context);
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
        toolCheckPermissions: tool.checkPermissions,
        content: context.cwd,
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
      toolCheckPermissions: tool.checkPermissions,
      content: context.cwd,
      config: this.permissionConfig,
    });
  }

  /**
   * Get registered tool names
   */
  getRegisteredTools(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * Check if a tool is registered
   */
  hasTool(toolName: string): boolean {
    return this.tools.has(toolName);
  }
}
