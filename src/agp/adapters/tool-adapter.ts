/**
 * AGP Tool Adapter
 *
 * Converts existing kc-cli ToolDefinition objects into AGP
 * ResourceRegistrationRecord<'Tool'> format and vice versa.
 *
 * This is the bridge between the existing tool system and the AGP RSPL layer.
 */

import type { ToolDefinition } from '../../types/tools';
import type { ResourceRegistrationRecord, ResourceEntity, ToolMetadata, ExportedRepresentation } from '../protocol';
import { createResourceEntity, createRegistrationRecord, createFunctionCallingRep } from '../types';

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
 */
function describeZodSchema(schema: any): Record<string, unknown> {
  try {
    return zodToJsonSchema(schema);
  } catch {
    return { type: 'unknown', description: 'Schema could not be extracted' };
  }
}

/**
 * Convert a Zod schema to a JSON Schema-like object.
 * Handles common Zod types: object, string, number, boolean, array, enum, optional.
 */
function zodToJsonSchema(schema: any): Record<string, unknown> {
  if (!schema || !schema._def) {
    return { type: 'unknown' };
  }

  const def = schema._def;
  const typeName = def.typeName;

  switch (typeName) {
    case 'ZodObject': {
      const properties: Record<string, unknown> = {};
      const required: string[] = [];

      if (def.shape) {
        const shape = typeof def.shape === 'function' ? def.shape() : def.shape;
        for (const [key, value] of Object.entries(shape)) {
          properties[key] = zodToJsonSchema(value);
          // Check if field is optional
          const fieldDef = (value as any)?._def;
          if (fieldDef?.typeName !== 'ZodOptional') {
            required.push(key);
          }
        }
      }

      return {
        type: 'object',
        properties,
        required: required.length > 0 ? required : undefined,
      };
    }

    case 'ZodString':
      return { type: 'string', description: def.description };

    case 'ZodNumber':
      return { type: 'number', description: def.description };

    case 'ZodBoolean':
      return { type: 'boolean', description: def.description };

    case 'ZodArray':
      return {
        type: 'array',
        items: def.type ? zodToJsonSchema(def.type) : { type: 'unknown' },
      };

    case 'ZodEnum':
      return {
        type: 'string',
        enum: def.values,
      };

    case 'ZodOptional':
      return {
        ...zodToJsonSchema(def.innerType),
        optional: true,
      };

    case 'ZodDefault':
      return {
        ...zodToJsonSchema(def.innerType),
        default: def.defaultValue?.(),
      };

    case 'ZodLiteral':
      return { type: typeof def.value, const: def.value };

    case 'ZodUnion':
      return {
        oneOf: def.options?.map((opt: any) => zodToJsonSchema(opt)) ?? [],
      };

    default:
      return { type: 'unknown', zodType: typeName };
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
