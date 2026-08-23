/**
 * T22 (audit round 3) — migration safety net for src/utils/zodToJsonSchema.ts.
 *
 * The handwritten converter (≈44 `_def` internals accesses) was replaced by a
 * thin wrapper over `zod-to-json-schema`. The handwritten implementation is
 * DELETED from src/; it survives verbatim below as a frozen fixture so every
 * registered tool schema can still be pushed through BOTH implementations:
 *
 *   - legacyConvert(): verbatim pre-migration implementation (fixture)
 *   - zodToJsonSchema(): the live post-migration wrapper
 *
 * plus a byte-level snapshot of the old outputs captured BEFORE the rewrite
 * (`fixtures/zod-json-schema-legacy-v1.json`) proves the embedded copy is
 * faithful and that the zod ^3.23.8 → ^3.25 upgrade did not shift legacy
 * behavior.
 *
 * Equivalence is asserted modulo the explicitly adjudicated allow-list in
 * `canonicalize()` below. Anything outside those rules fails the suite.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import legacySnapshots from './fixtures/zod-json-schema-legacy-v1.json';
import { TOOL_MANIFEST, loadToolModule, type ToolManifestEntry } from '../../src/tools/registry';
import { zodToJsonSchema } from '../../src/utils/zodToJsonSchema';

// ---------------------------------------------------------------------------
// Frozen fixture: the deleted handwritten implementation (verbatim copy of the
// pre-T22 src/utils/zodToJsonSchema.ts, exports dropped, name prefixed).
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
function legacyZodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  return legacyConvertSchema(schema);
}

function legacyConvertSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  // Handle ZodEffects (from .refine(), .transform(), etc.)
  if (schema._def.typeName === 'ZodEffects') {
    const innerSchema = (schema as z.ZodEffects<any>)._def.schema;
    return legacyConvertSchema(innerSchema);
  }

  // Handle ZodOptional
  if (schema._def.typeName === 'ZodOptional') {
    const innerType = (schema as z.ZodOptional<any>)._def.innerType;
    return legacyConvertSchema(innerType);
  }

  // Handle ZodDefault
  if (schema._def.typeName === 'ZodDefault') {
    const innerType = (schema as z.ZodDefault<any>)._def.innerType;
    const result = legacyConvertSchema(innerType);
    result.default = (schema as z.ZodDefault<any>)._def.defaultValue();
    return result;
  }

  // Handle ZodNullable
  if (schema._def.typeName === 'ZodNullable') {
    const innerType = (schema as z.ZodNullable<any>)._def.innerType;
    const result = legacyConvertSchema(innerType);
    result.nullable = true;
    return result;
  }

  // Handle ZodObject
  if (schema._def.typeName === 'ZodObject') {
    return legacyConvertObject(schema as z.ZodObject<any>);
  }

  // Handle ZodArray
  if (schema._def.typeName === 'ZodArray') {
    return legacyConvertArray(schema as z.ZodArray<any>);
  }

  // Handle ZodString
  if (schema._def.typeName === 'ZodString') {
    return legacyConvertString(schema as z.ZodString);
  }

  // Handle ZodNumber
  if (schema._def.typeName === 'ZodNumber') {
    return legacyConvertNumber(schema as z.ZodNumber);
  }

  // Handle ZodBoolean
  if (schema._def.typeName === 'ZodBoolean') {
    return { type: 'boolean' };
  }

  // Handle ZodEnum
  if (schema._def.typeName === 'ZodEnum') {
    return {
      type: 'string',
      enum: (schema as z.ZodEnum<any>)._def.values,
    };
  }

  // Handle ZodNativeEnum
  if (schema._def.typeName === 'ZodNativeEnum') {
    return {
      type: 'string',
      enum: Object.values((schema as z.ZodNativeEnum<any>)._def.values),
    };
  }

  // Handle ZodUnion
  if (schema._def.typeName === 'ZodUnion') {
    const options = (schema as z.ZodUnion<any>)._def.options;
    return {
      oneOf: options.map((opt: z.ZodTypeAny) => legacyConvertSchema(opt)),
    };
  }

  // Handle ZodLiteral
  if (schema._def.typeName === 'ZodLiteral') {
    return {
      type: typeof (schema as z.ZodLiteral<any>)._def.value,
      const: (schema as z.ZodLiteral<any>)._def.value,
    };
  }

  // Handle ZodRecord
  if (schema._def.typeName === 'ZodRecord') {
    return {
      type: 'object',
      additionalProperties: legacyConvertSchema((schema as z.ZodRecord<any, any>)._def.valueType),
    };
  }

  // Handle ZodTuple
  if (schema._def.typeName === 'ZodTuple') {
    const items = (schema as z.ZodTuple<any>)._def.items;
    return {
      type: 'array',
      items: items.map((item: z.ZodTypeAny) => legacyConvertSchema(item)),
      minItems: items.length,
      maxItems: items.length,
    };
  }

  // Handle ZodIntersection
  if (schema._def.typeName === 'ZodIntersection') {
    const intersection = schema as z.ZodIntersection<any, any>;
    return {
      allOf: [legacyConvertSchema(intersection._def.left), legacyConvertSchema(intersection._def.right)],
    };
  }

  // Handle ZodMap
  if (schema._def.typeName === 'ZodMap') {
    return {
      type: 'object',
      additionalProperties: legacyConvertSchema((schema as z.ZodMap<any, any>)._def.valueType),
    };
  }

  // Handle ZodSet
  if (schema._def.typeName === 'ZodSet') {
    return {
      type: 'array',
      items: legacyConvertSchema((schema as z.ZodSet<any>)._def.valueType),
      uniqueItems: true,
    };
  }

  // Handle ZodDate
  if (schema._def.typeName === 'ZodDate') {
    return { type: 'string', format: 'date-time' };
  }

  // Handle ZodBigInt
  if (schema._def.typeName === 'ZodBigInt') {
    return { type: 'string', pattern: '^-?\\d+$' };
  }

  // Handle ZodAny / ZodUnknown
  if (schema._def.typeName === 'ZodAny' || schema._def.typeName === 'ZodUnknown') {
    return {};
  }

  // Fallback for unsupported types
  return { type: 'object' };
}

function legacyConvertObject(schema: z.ZodObject<any>): Record<string, unknown> {
  const shape = schema.shape;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, value] of Object.entries(shape)) {
    const fieldSchema = value as z.ZodTypeAny;
    properties[key] = legacyConvertSchema(fieldSchema);

    // Check if field is required (not optional)
    if (!legacyIsOptional(fieldSchema)) {
      required.push(key);
    }
  }

  const result: Record<string, unknown> = {
    type: 'object',
    properties,
  };

  if (required.length > 0) {
    result.required = required;
  }

  return result;
}

function legacyConvertArray(schema: z.ZodArray<any>): Record<string, unknown> {
  const result: Record<string, unknown> = {
    type: 'array',
    items: legacyConvertSchema(schema._def.type),
  };

  // Add min/max length constraints
  const def = schema._def;
  if (def.minLength !== null) {
    result.minItems = def.minLength.value;
  }
  if (def.maxLength !== null) {
    result.maxItems = def.maxLength.value;
  }

  return result;
}

function legacyConvertString(schema: z.ZodString): Record<string, unknown> {
  const result: Record<string, unknown> = { type: 'string' };
  const checks = schema._def.checks || [];

  for (const check of checks) {
    switch (check.kind) {
      case 'min':
        result.minLength = check.value;
        break;
      case 'max':
        result.maxLength = check.value;
        break;
      case 'email':
        result.format = 'email';
        break;
      case 'url':
        result.format = 'uri';
        break;
      case 'uuid':
        result.format = 'uuid';
        break;
      case 'datetime':
        result.format = 'date-time';
        break;
      case 'regex':
        result.pattern = check.regex.source;
        break;
    }
  }

  // Handle description from ZodString
  if (schema.description) {
    result.description = schema.description;
  }

  return result;
}

function legacyConvertNumber(schema: z.ZodNumber): Record<string, unknown> {
  const result: Record<string, unknown> = { type: 'number' };
  const checks = schema._def.checks || [];

  for (const check of checks) {
    switch (check.kind) {
      case 'min':
        if (check.inclusive) {
          result.minimum = check.value;
        } else {
          result.exclusiveMinimum = check.value;
        }
        break;
      case 'max':
        if (check.inclusive) {
          result.maximum = check.value;
        } else {
          result.exclusiveMaximum = check.value;
        }
        break;
      case 'int':
        result.type = 'integer';
        break;
    }
  }

  return result;
}

function legacyIsOptional(schema: z.ZodTypeAny): boolean {
  if (schema._def.typeName === 'ZodOptional') return true;
  if (schema._def.typeName === 'ZodDefault') return true;
  // Recursively unwrap ZodEffects (refine/transform) to detect wrapped optional fields
  if (schema._def.typeName === 'ZodEffects') {
    return legacyIsOptional((schema as z.ZodEffects<any>)._def.schema);
  }
  return false;
}

/* eslint-enable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Allow-list normalizer.
//
// Adjudicated difference kinds (old handwritten → zod-to-json-schema@3.25):
//
//  A1  root `$schema` added ("http://json-schema.org/draft-07/schema#")
//      → stripped on both sides. Inert metadata; consumers (LLM tool APIs)
//        ignore it. ACCEPTED.
//
//  A2  object nodes gain `"additionalProperties": false`
//      → stripped on the new side. Semantically CORRECT for zod objects
//        (z.object strips unknown keys when parsing); the old converter's
//        omission was a fidelity bug. ACCEPTED.
//
//  A3  `.describe()` metadata preserved everywhere
//      (old converter kept descriptions ONLY on top-level strings, dropping
//      them on numbers/booleans/arrays/objects/enums/nested nodes)
//      → `description` keys stripped from BOTH sides for structural equality,
//        then separately asserted as a superset (nothing lost, some added).
//        Additive, restores author intent. ACCEPTED.
//
//  A4  union representation: `oneOf: [...]` → `anyOf: [...]` / primitive
//      unions → `type: ["a","b"]`
//      → keys `oneOf` renamed to `anyOf`; `type` arrays collapsed by removing
//        `"null"` members (nullable handling, A5) — remaining multi-type
//        arrays are treated as equivalent to the corresponding anyOf form by
//        dropping them in favor of the legacy comparison only when the legacy
//        side is a oneOf over scalars. ACCEPTED (equivalent selection
//        semantics; anyOf is the canonical draft-07 mapping zts emits).
//
//  A5  nullable representation: legacy OpenAPI-style `nullable: true`
//      (invalid in draft-07) → draft-07-valid `type: [..., "null"]` for
//      primitives, or anyOf [<inner>, { type: "null" }] for objects
//      → normalized: remove `"null"` members / collapse the null-branch and
//        re-add `nullable: true` so both sides meet in the middle. ACCEPTED.
//
//  A6  root-level ZodOptional renders as anyOf [{ not: {} }, <inner>] instead
//      of unwrapping to <inner> → normalized to <inner>. No registered tool
//      has an optional root schema; ACCEPTED for parity with the legacy
//      unwrap behavior.
//
// Nothing outside A1–A6 is normalized: any other structural change fails.
// ---------------------------------------------------------------------------

type JsonSchemaNode = Record<string, unknown>;

function stripDescriptions(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripDescriptions);
  if (node && typeof node === 'object') {
    const out: JsonSchemaNode = {};
    for (const [k, v] of Object.entries(node as JsonSchemaNode)) {
      if (k === 'description') continue;
      out[k] = stripDescriptions(v);
    }
    return out;
  }
  return node;
}

function normalizeLegacySide(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(normalizeLegacySide);
  if (!node || typeof node !== 'object') return node;
  const out: JsonSchemaNode = {};
  for (const [k, v] of Object.entries(node as JsonSchemaNode)) {
    const key = k === 'oneOf' ? 'anyOf' : k; // A4
    // A4 (primitive unions): legacy `anyOf` over bare `{ type: <scalar> }`
    // items ≡ modern `type: [<scalar>, ...]` — lift both onto the type-array
    // form. Items carrying more than `type` stay untouched.
    if (
      key === 'anyOf' &&
      Array.isArray(v) &&
      v.length > 0 &&
      v.every(
        item =>
          item &&
          typeof item === 'object' &&
          Object.keys(item).length === 1 &&
          typeof (item as JsonSchemaNode).type === 'string',
      )
    ) {
      out.type = (v as JsonSchemaNode[]).map(item => item.type);
      continue;
    }
    out[key] = normalizeLegacySide(v);
  }
  return out;
}

function normalizeNewSide(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(normalizeNewSide);
  if (!node || typeof node !== 'object') return node;
  const src = node as JsonSchemaNode;
  // A6: root-level ZodOptional renders as anyOf [{ not: {} }, <inner>];
  // the old converter unwrapped it. Normalize to <inner>.
  if (Array.isArray(src.anyOf) && src.anyOf.length === 2) {
    const [m0, m1] = src.anyOf as JsonSchemaNode[];
    const isNotAny = (m: JsonSchemaNode | undefined) =>
      !!m && Object.keys(m).length === 1 && JSON.stringify(m.not) === '{}';
    if (isNotAny(m0) || isNotAny(m1)) {
      return normalizeNewSide(isNotAny(m0) ? m1 : m0);
    }
  }
  const out: JsonSchemaNode = {};
  let sawNullMember = false;
  for (const [key, value] of Object.entries(src)) {
    if (key === '$schema') continue; // A1
    if (key === 'additionalProperties' && value === false) continue; // A2
    if (key === 'type' && Array.isArray(value)) {
      // A4/A5: collapse type arrays; remember removed "null" members (A5).
      const members = (value as unknown[]).filter(m => {
        if (m === 'null') {
          sawNullMember = true;
          return false;
        }
        return true;
      });
      out.type = members.length === 1 ? members[0] : members;
      continue;
    }
    if (key === 'anyOf' && Array.isArray(value)) {
      // A5b: object ZodNullable renders as anyOf [<inner>, { type: 'null' }];
      // the old converter emitted { ...<inner>, nullable: true }. Drop the
      // bare null member and mark nullable instead. Unions that genuinely
      // contain more than one non-null branch are left untouched.
      const nonNull = (value as unknown[]).filter(
        m => !(m && typeof m === 'object' && Object.keys(m as JsonSchemaNode).length === 1 && (m as JsonSchemaNode).type === 'null'),
      );
      if (nonNull.length !== value.length) {
        sawNullMember = true;
        if (nonNull.length === 1) {
          const inlined = normalizeNewSide(nonNull[0]);
          Object.assign(out, inlined as JsonSchemaNode);
          continue;
        }
        out.anyOf = nonNull.map(normalizeNewSide);
        continue;
      }
    }
    out[key] = normalizeNewSide(value);
  }
  if (sawNullMember && !('nullable' in out)) out.nullable = true; // A5/A5b
  return out;
}

/** Collect [path, description] pairs for the superset assertion (A3). */
function collectDescriptions(node: unknown, path: string, out: Map<string, unknown>): void {
  if (Array.isArray(node)) {
    node.forEach((item, i) => collectDescriptions(item, `${path}[${i}]`, out));
    return;
  }
  if (!node || typeof node !== 'object') return;
  const obj = node as JsonSchemaNode;
  if (typeof obj.description === 'string') out.set(path, obj.description);
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'description') continue;
    collectDescriptions(v, path ? `${path}.${k}` : k, out);
  }
}

// ---------------------------------------------------------------------------
// Load every registered tool through the registry's own loader.
// Failures are loud (no silent skips): a missing tool definition throws.
// ---------------------------------------------------------------------------

interface LoadedTool {
  name: string;
  inputSchema: z.ZodTypeAny;
}

async function loadAllRegisteredTools(): Promise<LoadedTool[]> {
  const loaded: LoadedTool[] = [];
  for (const entry of ToolManifestEntries()) {
    const tool = await loadToolModule(entry);
    if (!tool) throw new Error(`T22 migration test: failed to load tool "${entry.name}" (${entry.modulePath})`);
    loaded.push({ name: entry.name, inputSchema: tool.inputSchema });
  }
  return loaded;
}

function ToolManifestEntries(): readonly ToolManifestEntry[] {
  return TOOL_MANIFEST;
}

const snapshots = legacySnapshots as {
  $comment: string;
  capturedWith: { zod: string; toolCount: number };
  schemas: Record<string, JsonSchemaNode>;
};

describe('zodToJsonSchema T22 migration (handwritten → zod-to-json-schema)', () => {
  let tools: LoadedTool[];

  it('loads every TOOL_MANIFEST tool and matches the fixture inventory', async () => {
    tools = await loadAllRegisteredTools();
    const names = tools.map(t => t.name);
    expect(names).toEqual(Object.keys(snapshots.schemas));
    expect(names).toHaveLength(TOOL_MANIFEST.length);
    expect(snapshots.capturedWith.toolCount).toBe(TOOL_MANIFEST.length);
  });

  it('embedded legacy fixture reproduces the captured pre-migration outputs (deep-equal)', async () => {
    tools ??= await loadAllRegisteredTools();
    for (const tool of tools) {
      const legacyOutput = legacyZodToJsonSchema(tool.inputSchema);
      expect(
        legacyOutput,
        `embedded legacy converter drifted from frozen snapshot for tool ${tool.name}`,
      ).toEqual(snapshots.schemas[tool.name]);
    }
  });

  it('live wrapper ≡ legacy converter for all registered schemas (modulo allow-list A1–A6)', async () => {
    tools ??= await loadAllRegisteredTools();
    for (const tool of tools) {
      const legacy = normalizeLegacySide(stripDescriptions(legacyZodToJsonSchema(tool.inputSchema)));
      const modern = normalizeNewSide(stripDescriptions(zodToJsonSchema(tool.inputSchema)));
      expect(modern, `allow-listed mismatch for tool ${tool.name}`).toEqual(legacy);
    }
  });

  it('descriptions are a strict superset: nothing the old converter kept was dropped (A3)', async () => {
    tools ??= await loadAllRegisteredTools();
    for (const tool of tools) {
      const legacyDesc = new Map<string, unknown>();
      const modernDesc = new Map<string, unknown>();
      collectDescriptions(legacyZodToJsonSchema(tool.inputSchema), '', legacyDesc);
      collectDescriptions(zodToJsonSchema(tool.inputSchema), '', modernDesc);
      for (const [path, text] of legacyDesc) {
        expect(
          modernDesc.get(path),
          `description lost at ${tool.name}${path || '/'} `,
        ).toBe(text);
      }
    }
  });

  it('live wrapper emits clean JSON Schema: object root, properties, zero _def leakage', async () => {
    tools ??= await loadAllRegisteredTools();
    for (const tool of tools) {
      const converted = zodToJsonSchema(tool.inputSchema);
      expect(converted.type).toBe('object');
      expect(converted.properties).toBeTypeOf('object');
      expect(JSON.stringify(converted)).not.toContain('_def');
      expect(JSON.stringify(converted)).not.toContain('typeName');
    }
  });
});
