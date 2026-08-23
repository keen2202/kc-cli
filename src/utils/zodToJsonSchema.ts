// Zod to JSON Schema converter
// Converts Zod schemas to JSON Schema format for LLM tool definitions
//
// T22 (audit round 3): the handwritten conversion here reached deep into
// zod's private definition internals (~44 accesses) and silently dropped
// `.describe()` metadata on non-string nodes. It is now a thin wrapper over the maintained
// `zod-to-json-schema` package (direct dependency since T22). The deleted
// implementation is preserved as a frozen fixture inside
// test/utils/zodToJsonSchema-migration.test.ts together with captured
// pre-migration outputs for every registered tool schema
// (test/utils/fixtures/zod-json-schema-legacy-v1.json); that suite asserts
// equivalence of old and new output modulo an explicitly adjudicated
// allow-list ($schema / additionalProperties:false / descriptions /
// anyOf unions / draft-07 nullability).

import { z } from 'zod';
import { zodToJsonSchema as convertWithZodToJsonSchema } from 'zod-to-json-schema';

/**
 * Convert a Zod schema to JSON Schema format
 * Supports the most common Zod types used in tool definitions
 */
export function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  return convertWithZodToJsonSchema(schema, {
    // Inline everything: no `$ref`/`definitions` indirection in tool payloads
    // (the deleted implementation also inlined; recursion was unsupported).
    $refStrategy: 'none',
  }) as Record<string, unknown>;
}
