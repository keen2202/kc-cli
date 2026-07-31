/**
 * AGP Tool Adapter
 *
 * Converts existing kc-cli ToolDefinition objects into AGP
 * ResourceRegistrationRecord<'Tool'> format and vice versa.
 *
 * This is the bridge between the existing tool system and the AGP RSPL layer.
 */

import type { ToolDefinition } from '../../tools/protocol';
import type { ResourceRegistrationRecord, ResourceEntity, ToolMetadata, ExportedRepresentation } from '../protocol';
import { createResourceEntity, createRegistrationRecord, createFunctionCallingRep } from '../types';
import { zodToJsonSchema } from '../../utils/zodToJsonSchema';

// ─── ToolDefinition → RSPL Record ────────────────────────────────────────────

/**
 * Convert a ToolDefinition to an AGP ResourceRegistrationRecord.
 *
 * The conversion is non-destructive: the original ToolDefinition is not modified.
 * AGP extension fields on the tool (agpEvolvability, agpVersion, etc.) are used
 * if present, otherwise sensible defaults are applied.
 */
export function toolToRecord(tool: ToolDefinition): ResourceRegistrationRecord<'Tool'> {
  const metadata: ToolMetadata = {
    readOnly: tool.isReadOnly ? tool.isReadOnly({}) : false,
    concurrencySafe: tool.isConcurrencySafe ? tool.isConcurrencySafe({}) : false,
    priority: tool.shouldDefer ? 'deferred' : (tool.alwaysLoad ? 'eager' : 'lazy'),
    importPath: tool.agpImplementationDescriptor,
  };

  const entity: ResourceEntity<'Tool'> = createResourceEntity('Tool', tool.name, tool.description, {
    evolvability: tool.agpEvolvability ?? 0,
    ioMapping: {
      inputSchema: describeZodSchema(tool.inputSchema),
      outputSchema: tool.outputSchema ? describeZodSchema(tool.outputSchema) : undefined,
      callable: async (input: unknown) => {
        // Callable wraps the tool's call method
        // Context would need to be provided at call time
        return { pending: true, message: 'Tool requires ToolUseContext for execution' };
      },
    },
    metadata,
  });

  // Build exported representations (function-calling schema for LLM)
  const exportedRepresentations: ExportedRepresentation[] = [];
  try {
    const schemaJson = zodToJsonSchema(tool.inputSchema);
    exportedRepresentations.push(
      createFunctionCallingRep({
        name: tool.name,
        description: tool.description,
        input_schema: schemaJson,
      })
    );
  } catch {
    // Fallback: text description
    exportedRepresentations.push({
      format: 'text',
      content: `${tool.name}: ${tool.description}`,
    });
  }

  return createRegistrationRecord(entity, {
    version: tool.agpVersion ?? '1.0.0',
    implementationDescriptor: tool.agpImplementationDescriptor ?? `tools/${tool.name}`,
    instantiationParams: {
      searchHint: tool.searchHint,
      timeout: tool.timeout,
    },
    exportedRepresentations,
  });
}

// ─── RSPL Record → ToolDefinition patches ────────────────────────────────────

/**
 * Apply AGP record changes back to a ToolDefinition.
 * Only updates AGP-related fields; does NOT modify the tool's call method.
 *
 * This is used by the SEPL Commit operator to propagate evolved state
 * back to the live tool definition.
 */
export function applyRecordToTool(
  tool: ToolDefinition,
  record: ResourceRegistrationRecord<'Tool'>
): ToolDefinition {
  return {
    ...tool,
    description: record.entity.description,
    agpEvolvability: record.entity.evolvability,
    agpVersion: record.version,
    agpImplementationDescriptor: record.implementationDescriptor,
  };
}

// ─── Helper: Zod Schema Description ──────────────────────────────────────────

/**
 * Extract a human-readable description from a Zod schema.
 * Returns a JSON-like object description.
 * Delegates to the canonical converter in src/utils/zodToJsonSchema
 * (a hand-rolled local duplicate was removed in the dedup pass).
 */
function describeZodSchema(schema: any): Record<string, unknown> {
  try {
    return zodToJsonSchema(schema);
  } catch {
    return { type: 'unknown', description: 'Schema could not be extracted' };
  }
}

// ─── Batch Operations ────────────────────────────────────────────────────────

/**
 * Convert an array of ToolDefinitions to RSPL records.
 */
export function toolsToRecords(tools: ToolDefinition[]): ResourceRegistrationRecord<'Tool'>[] {
  return tools.map(toolToRecord);
}

/**
 * Register all tools from a ToolRegistry-like source into an AGP GlobalRegistry.
 */
export function registerToolsInRegistry(
  tools: ToolDefinition[],
  registry: { register: (type: 'Tool', record: ResourceRegistrationRecord<'Tool'>) => string }
): number {
  let registered = 0;
  for (const tool of tools) {
    try {
      const record = toolToRecord(tool);
      registry.register('Tool', record);
      registered++;
    } catch {
      // Tool may already be registered, skip duplicates
    }
  }
  return registered;
}
