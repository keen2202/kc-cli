// MCP Tool Bridge - Converts MCP tool definitions to KC-CLI ToolDefinition format

import { z } from 'zod';
import { buildTool, toolResult, toolError } from '../Tool';
import type { ToolDefinition, ToolResult as ToolResultType, ToolUseContext } from '../types/tools';
import type { MCPTool, MCPToolResult } from './types';
import type { MCPClientManager } from './client-manager';

function jsonSchemaToZod(schema: MCPTool['inputSchema']): z.ZodType<any> {
  if (!schema || schema.type !== 'object') {
    return z.object({}).passthrough();
  }

  const shape: Record<string, z.ZodType<any>> = {};
  const properties = schema.properties || {};
  const required = new Set(schema.required || []);

  for (const [key, prop] of Object.entries(properties)) {
    const p = prop as Record<string, unknown>;
    let field: z.ZodType<any>;

    switch (p.type) {
      case 'string':
        field = z.string();
        break;
      case 'number':
        field = z.number();
        break;
      case 'boolean':
        field = z.boolean();
        break;
      case 'integer':
        field = z.number().int();
        break;
      case 'array':
        field = z.array(z.unknown());
        break;
      case 'object':
        field = z.object({}).passthrough();
        break;
      default:
        field = z.unknown();
    }

    if (p.description) {
      field = field.describe(p.description as string);
    }

    if (!required.has(key)) {
      field = field.optional();
    }

    shape[key] = field;
  }

  return z.object(shape);
}

function formatMCPToolResult(result: MCPToolResult): string {
  const parts: string[] = [];

  for (const item of result.content) {
    if (item.type === 'text') {
      parts.push(item.text);
    } else if (item.type === 'image') {
      parts.push(`[Image: ${item.mimeType}]`);
    } else if (item.type === 'resource') {
      parts.push(`[Resource: ${item.resource.uri}]`);
    }
  }

  return parts.join('\n');
}

export function convertMCPTool(
  mcpTool: MCPTool,
  serverId: string,
  clientManager: MCPClientManager
): ToolDefinition {
  const inputSchema = jsonSchemaToZod(mcpTool.inputSchema);

  const tool = buildTool<Record<string, unknown>, string>({
    name: `mcp_${serverId}_${mcpTool.name}` as any,
    description: `[MCP:${serverId}] ${mcpTool.description || mcpTool.name}`,

    inputSchema,

    call: async (input: Record<string, unknown>, _context: ToolUseContext): Promise<ToolResultType<string>> => {
      try {
        const result = await clientManager.callTool(serverId, mcpTool.name, input);
        const output = formatMCPToolResult(result);

        if (result.isError) {
          return toolError(output);
        }
        return toolResult(output);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return toolError(`MCP tool error: ${msg}`);
      }
    },

    checkPermissions: () => ({
      behavior: 'ask' as const,
      message: `MCP tool: ${mcpTool.name} (server: ${serverId})`,
    }),

    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    isDestructive: () => false,

    prompt: ({ input }) => `Execute ${mcpTool.name} on MCP server ${serverId}`,
    getToolUseSummary: (input: Record<string, unknown>) =>
      `mcp:${serverId}/${mcpTool.name}(${JSON.stringify(input).slice(0, 100)})`,
    getActivityDescription: (input: Record<string, unknown>) =>
      `Calling MCP tool ${mcpTool.name} on ${serverId}`,
  });

  return tool;
}
