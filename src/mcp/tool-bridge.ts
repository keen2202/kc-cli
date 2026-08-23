// MCP Tool Bridge - Converts MCP tool definitions to KC-CLI ToolDefinition format
//
// Trust boundary (audit round3 §H5 / T08): everything arriving here originates
// from an EXTERNAL MCP server (config or plugin-contributed) and must be
// validated before it may enter the tool registry:
//   1. Composed tool names are checked against a whitelist pattern via
//      toValidatedToolName() — the only place allowed to produce a `ToolName`
//      from remote data (no scattered `as any` casts).
//   2. Remote JSON Schemas are shape-validated (must be a real object schema)
//      before conversion, the converted Zod schema is re-checked to be an
//      object schema, and every invocation safeParses its inputs.
//   3. Any refusal is observable: logger.mcp.warn + a disabled ToolDefinition
//      (isEnabled() === false keeps it out of getAllTools()/assembleToolPool())
//      whose call() returns a clear error result instead of ever reaching the
//      remote server.

import { z } from 'zod';
import { buildTool, toolResult, toolError } from '../Tool';
import type {
  ToolDefinition,
  ToolResult as ToolResultType,
  ToolUseContext,
  ToolName,
} from '../tools/protocol';
import type { MCPTool, MCPToolResult } from './types';
import type { MCPClientManager } from './client-manager';
import { logger } from '../services/logger';

// ── H5: tool-name whitelist (trust boundary) ─────────────────────────────────

/** Whitelist for composed external tool names: `mcp_<serverId>_<toolName>`. */
export const MCP_TOOL_NAME_PATTERN = /^mcp_[A-Za-z0-9_-]+$/;

/** Total length cap for a composed tool name (prefix included). */
export const MCP_TOOL_NAME_MAX_LENGTH = 128;

/**
 * Typed constructor for external tool names — the single audited choke point
 * that turns remote `serverId`/`toolName` strings into a `ToolName`.
 *
 * Returns `null` when the composed name violates the whitelist pattern or the
 * length cap; callers must treat `null` as "registration refused". The single
 * assertion below is what makes the function a constructor instead of a cast:
 * it is reachable ONLY after the whitelist match proved the string well-formed,
 * so no unvalidated remote string can acquire the `ToolName` brand elsewhere.
 */
export function toValidatedToolName(serverId: string, toolName: string): ToolName | null {
  const composed = `mcp_${serverId}_${toolName}`;

  if (composed.length > MCP_TOOL_NAME_MAX_LENGTH) {
    return null;
  }
  // The character class excludes path separators, dots (`..` traversal),
  // whitespace, unicode letters and all control characters.
  if (!MCP_TOOL_NAME_PATTERN.test(composed)) {
    return null;
  }

  return composed as ToolName;
}

// ── H5: remote JSON-Schema shape validation (trust boundary) ────────────────

export type MCPInputSchemaCheck = { ok: true } | { ok: false; reason: string };

/** Property keys that would pollute `Object.prototype` when folded into a Zod shape. */
const FORBIDDEN_PROPERTY_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

/** Property-key sanity limits applied at the trust boundary. */
const MAX_PROPERTY_NAME_LENGTH = 128;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Minimal shape validation for a remote JSON Schema BEFORE conversion.
 * Requires a real object schema with sane property names; anything looser
 * (missing schema, non-object type, malformed properties/required) is refused.
 */
export function validateMCPInputSchema(schema: unknown): MCPInputSchemaCheck {
  if (schema === undefined || schema === null) {
    return { ok: false, reason: 'inputSchema is missing' };
  }
  if (typeof schema !== 'object' || Array.isArray(schema)) {
    return { ok: false, reason: 'inputSchema must be a JSON object' };
  }

  const s = schema as Record<string, unknown>;

  if (s.type !== 'object') {
    return { ok: false, reason: `inputSchema.type must be "object" (got ${String(s.type)})` };
  }

  if (s.properties !== undefined && s.properties !== null) {
    if (typeof s.properties !== 'object' || Array.isArray(s.properties)) {
      return { ok: false, reason: 'inputSchema.properties must be an object' };
    }
    for (const key of Object.keys(s.properties)) {
      if (
        key.length === 0 ||
        key.length > MAX_PROPERTY_NAME_LENGTH ||
        CONTROL_CHARS.test(key) ||
        FORBIDDEN_PROPERTY_NAMES.has(key)
      ) {
        return { ok: false, reason: `inputSchema property name rejected: "${key.slice(0, 32)}"` };
      }
    }
  }

  if (s.required !== undefined && s.required !== null) {
    if (!Array.isArray(s.required) || s.required.some(r => typeof r !== 'string')) {
      return { ok: false, reason: 'inputSchema.required must be an array of property names' };
    }
  }

  return { ok: true };
}

// ── Conversion helpers ───────────────────────────────────────────────────────

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

// ── H5: refusal path ─────────────────────────────────────────────────────────

/**
 * Placeholder registry key for refused registrations. Multiple refusals share
 * this key (later ones overwrite earlier ones in the registry map) — that is
 * intentional: refused definitions are inert and never surfaced to the model
 * (isEnabled() === false filters them out of getAllTools()), while the actual
 * identifying details travel through logger.mcp.warn structured data.
 */
const REFUSED_TOOL_NAME = 'mcp_refused_registration';

/**
 * Build an inert ToolDefinition for a registration that failed trust-boundary
 * validation. convertMCPTool must keep returning a ToolDefinition (callers
 * register its result unconditionally), so refusal is expressed as:
 *   - isEnabled() === false  → excluded from the tool pool shown to the model
 *   - call()                 → clear error result, never reaches the server
 */
function refusedRegistration(reason: string): ToolDefinition {
  return {
    name: REFUSED_TOOL_NAME,
    description: `[MCP] Registration refused: ${reason}`,
    inputSchema: z.object({}).passthrough(),
    isEnabled: () => false,
    call: async () =>
      toolError(
        `MCP tool registration was refused by trust-boundary validation (${reason}); this tool cannot be invoked.`,
        { refused: true },
      ),
  };
}

// ── Public entry point ───────────────────────────────────────────────────────

export function convertMCPTool(
  mcpTool: MCPTool,
  serverId: string,
  clientManager: MCPClientManager
): ToolDefinition {
  // H5 ①: validate the composed external tool name before it touches the registry.
  const validatedName = toValidatedToolName(serverId, mcpTool.name);
  if (!validatedName) {
    logger.mcp.warn('[MCP] Refusing tool registration: invalid tool name', {
      serverId,
      tool: mcpTool.name,
      pattern: MCP_TOOL_NAME_PATTERN.source,
      maxLength: MCP_TOOL_NAME_MAX_LENGTH,
    });
    return refusedRegistration('invalid tool name');
  }

  // H5 ②a: shape-validate the remote JSON Schema before conversion.
  const schemaCheck = validateMCPInputSchema(mcpTool.inputSchema);
  if (!schemaCheck.ok) {
    logger.mcp.warn('[MCP] Refusing tool registration: invalid input schema', {
      serverId,
      tool: mcpTool.name,
      reason: schemaCheck.reason,
    });
    return refusedRegistration(`invalid input schema (${schemaCheck.reason})`);
  }

  // H5 ②b: the converted product must itself be an object schema (belt and
  // braces around jsonSchemaToZod; guarantees safeParse yields an object).
  const converted = jsonSchemaToZod(mcpTool.inputSchema);
  if (!(converted instanceof z.ZodObject)) {
    logger.mcp.warn('[MCP] Refusing tool registration: schema did not convert to an object schema', {
      serverId,
      tool: mcpTool.name,
    });
    return refusedRegistration('converted input schema is not an object schema');
  }
  const inputSchema: z.ZodObject<any> = converted;

  const tool = buildTool<Record<string, unknown>, string>({
    name: validatedName,
    description: `[MCP:${serverId}] ${mcpTool.description || mcpTool.name}`,

    inputSchema,

    call: async (input: Record<string, unknown>, _context: ToolUseContext): Promise<ToolResultType<string>> => {
      try {
        // H5 ②c: safeParse every invocation against the converted schema
        // before anything crosses back over the trust boundary.
        const parsed = inputSchema.safeParse(input ?? {});
        if (!parsed.success) {
          const issues = parsed.error.issues
            .map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
            .join('; ');
          return toolError(
            `Invalid input for MCP tool ${mcpTool.name} (server: ${serverId}): ${issues}`,
          );
        }

        const result = await clientManager.callTool(
          serverId,
          mcpTool.name,
          parsed.data as Record<string, unknown>
        );
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
