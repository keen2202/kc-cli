import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { zodToJsonSchema } from '../../src/utils/zodToJsonSchema';

/**
 * Coverage tests for src/utils/zodToJsonSchema.ts.
 *
 * T22 (audit round 3): the handwritten converter was replaced by a thin
 * wrapper over `zod-to-json-schema`. Expectations below were migrated to the
 * maintained package's draft-07 output. Differences vs the deleted handwritten
 * implementation are adjudicated in test/utils/zodToJsonSchema-migration.test.ts:
 *   - root `$schema` on every conversion
 *   - `additionalProperties: false` on every z.object node (zod strips unknown keys)
 *   - `.describe()` preserved on ALL nodes (old impl kept it only on strings)
 *   - unions → anyOf / primitive type arrays (was oneOf)
 *   - nullable → type arrays with "null" / anyOf + {type:"null"} (was `nullable:true`)
 *   - numeric nativeEnum type "number" (was "string"), bigint integer/int64,
 *     ZodPromise inner type, ZodMap entry tuples, null literal without const
 */

const $S = 'http://json-schema.org/draft-07/schema#';

// ---------------------------------------------------------------------------
// Basic types
// ---------------------------------------------------------------------------
describe('basic types', () => {
  it('converts ZodString', () => {
    expect(zodToJsonSchema(z.string())).toEqual({ type: 'string', $schema: $S });
  });

  it('converts ZodNumber', () => {
    expect(zodToJsonSchema(z.number())).toEqual({ type: 'number', $schema: $S });
  });

  it('converts ZodBoolean', () => {
    expect(zodToJsonSchema(z.boolean())).toEqual({ type: 'boolean', $schema: $S });
  });

  it('converts ZodEnum', () => {
    const schema = z.enum(['a', 'b', 'c']);
    expect(zodToJsonSchema(schema)).toEqual({
      type: 'string',
      enum: ['a', 'b', 'c'],
      $schema: $S,
    });
  });

  it('converts ZodNativeEnum (string enum)', () => {
    enum Color {
      Red = 'red',
      Green = 'green',
      Blue = 'blue',
    }
    const schema = z.nativeEnum(Color);
    expect(zodToJsonSchema(schema)).toEqual({
      type: 'string',
      enum: ['red', 'green', 'blue'],
      $schema: $S,
    });
  });

  it('converts ZodNativeEnum (numeric enum)', () => {
    enum Dir {
      Up,
      Down,
    }
    const schema = z.nativeEnum(Dir);
    // Maintained package emits the correct JSON type for numeric enums
    // (the handwritten converter wrongly declared "string").
    expect(zodToJsonSchema(schema)).toEqual({
      type: 'number',
      enum: [0, 1],
      $schema: $S,
    });
  });
});

// ---------------------------------------------------------------------------
// String constraints
// ---------------------------------------------------------------------------
describe('string constraints', () => {
  it('adds minLength and maxLength', () => {
    const schema = z.string().min(3).max(100);
    expect(zodToJsonSchema(schema)).toEqual({
      type: 'string',
      minLength: 3,
      maxLength: 100,
      $schema: $S,
    });
  });

  it('adds email format', () => {
    expect(zodToJsonSchema(z.string().email())).toEqual({
      type: 'string',
      format: 'email',
      $schema: $S,
    });
  });

  it('adds uri format', () => {
    expect(zodToJsonSchema(z.string().url())).toEqual({
      type: 'string',
      format: 'uri',
      $schema: $S,
    });
  });

  it('adds uuid format', () => {
    expect(zodToJsonSchema(z.string().uuid())).toEqual({
      type: 'string',
      format: 'uuid',
      $schema: $S,
    });
  });

  it('adds date-time format', () => {
    expect(zodToJsonSchema(z.string().datetime())).toEqual({
      type: 'string',
      format: 'date-time',
      $schema: $S,
    });
  });

  it('adds pattern from regex', () => {
    expect(zodToJsonSchema(z.string().regex(/^[a-z]+$/))).toEqual({
      type: 'string',
      pattern: '^[a-z]+$',
      $schema: $S,
    });
  });

  it('adds description', () => {
    expect(zodToJsonSchema(z.string().describe('A username'))).toEqual({
      type: 'string',
      description: 'A username',
      $schema: $S,
    });
  });

  it('combines multiple string constraints', () => {
    const schema = z.string().email().min(5).max(255).describe('Email address');
    expect(zodToJsonSchema(schema)).toEqual({
      type: 'string',
      format: 'email',
      minLength: 5,
      maxLength: 255,
      description: 'Email address',
      $schema: $S,
    });
  });

  it('handles string with no checks', () => {
    expect(zodToJsonSchema(z.string())).toEqual({ type: 'string', $schema: $S });
  });
});

// ---------------------------------------------------------------------------
// Number constraints
// ---------------------------------------------------------------------------
describe('number constraints', () => {
  it('adds inclusive minimum and maximum', () => {
    const schema = z.number().min(0).max(100);
    expect(zodToJsonSchema(schema)).toEqual({
      type: 'number',
      minimum: 0,
      maximum: 100,
      $schema: $S,
    });
  });

  it('adds exclusive minimum (gt)', () => {
    expect(zodToJsonSchema(z.number().gt(0))).toEqual({
      type: 'number',
      exclusiveMinimum: 0,
      $schema: $S,
    });
  });

  it('adds exclusive maximum (lt)', () => {
    expect(zodToJsonSchema(z.number().lt(100))).toEqual({
      type: 'number',
      exclusiveMaximum: 100,
      $schema: $S,
    });
  });

  it('adds int type', () => {
    expect(zodToJsonSchema(z.number().int())).toEqual({
      type: 'integer',
      $schema: $S,
    });
  });

  it('combines multiple number constraints', () => {
    const schema = z.number().gt(0).lt(100).int();
    expect(zodToJsonSchema(schema)).toEqual({
      type: 'integer',
      exclusiveMinimum: 0,
      exclusiveMaximum: 100,
      $schema: $S,
    });
  });

  it('handles number with no checks', () => {
    expect(zodToJsonSchema(z.number())).toEqual({ type: 'number', $schema: $S });
  });
});

// ---------------------------------------------------------------------------
// Array
// ---------------------------------------------------------------------------
describe('array', () => {
  it('converts simple array', () => {
    expect(zodToJsonSchema(z.array(z.string()))).toEqual({
      type: 'array',
      items: { type: 'string' },
      $schema: $S,
    });
  });

  it('emits minItems from min()', () => {
    expect(zodToJsonSchema(z.array(z.number()).min(1))).toEqual({
      type: 'array',
      items: { type: 'number' },
      minItems: 1,
      $schema: $S,
    });
  });

  it('emits maxItems from max()', () => {
    expect(zodToJsonSchema(z.array(z.boolean()).max(5))).toEqual({
      type: 'array',
      items: { type: 'boolean' },
      maxItems: 5,
      $schema: $S,
    });
  });

  it('emits both minItems and maxItems from min().max()', () => {
    const schema = z.array(z.string()).min(2).max(10);
    expect(zodToJsonSchema(schema)).toEqual({
      type: 'array',
      items: { type: 'string' },
      minItems: 2,
      maxItems: 10,
      $schema: $S,
    });
  });

  it('handles array with no constraints (any items omit the items key)', () => {
    expect(zodToJsonSchema(z.array(z.any()))).toEqual({
      type: 'array',
      $schema: $S,
    });
  });
});

// ---------------------------------------------------------------------------
// Object
// ---------------------------------------------------------------------------
describe('object', () => {
  it('converts flat object with all required fields', () => {
    const schema = z.object({
      name: z.string(),
      age: z.number(),
    });
    expect(zodToJsonSchema(schema)).toEqual({
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'number' },
      },
      required: ['name', 'age'],
      additionalProperties: false,
      $schema: $S,
    });
  });

  it('omits required when all fields are optional', () => {
    const schema = z.object({
      name: z.string().optional(),
      age: z.number().optional(),
    });
    const result = zodToJsonSchema(schema);
    expect(result).toEqual({
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'number' },
      },
      additionalProperties: false,
      $schema: $S,
    });
    expect(result).not.toHaveProperty('required');
  });

  it('includes only non-optional fields in required', () => {
    const schema = z.object({
      id: z.string(),
      name: z.string(),
      email: z.string().optional(),
    });
    expect(zodToJsonSchema(schema)).toEqual({
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        email: { type: 'string' },
      },
      required: ['id', 'name'],
      additionalProperties: false,
      $schema: $S,
    });
  });

  it('converts nested object', () => {
    const schema = z.object({
      meta: z.object({
        created: z.string(),
        count: z.number(),
      }),
    });
    expect(zodToJsonSchema(schema)).toEqual({
      type: 'object',
      properties: {
        meta: {
          type: 'object',
          properties: {
            created: { type: 'string' },
            count: { type: 'number' },
          },
          required: ['created', 'count'],
          additionalProperties: false,
        },
      },
      required: ['meta'],
      additionalProperties: false,
      $schema: $S,
    });
  });

  it('treats ZodDefault fields as optional (not required)', () => {
    const schema = z.object({
      name: z.string().default('hello'),
      age: z.number(),
    });
    const result = zodToJsonSchema(schema);
    expect(result).toEqual({
      type: 'object',
      properties: {
        name: { type: 'string', default: 'hello' },
        age: { type: 'number' },
      },
      required: ['age'],
      additionalProperties: false,
      $schema: $S,
    });
  });

  it('treats ZodOptional fields as optional in object', () => {
    const schema = z.object({
      a: z.string().optional(),
      b: z.number(),
    });
    const result = zodToJsonSchema(schema);
    expect(result).toHaveProperty('required', ['b']);
  });

  it('treats ZodOptional wrapped in ZodEffects as optional', () => {
    const schema = z.object({
      a: z.string().optional().refine((s) => !s || s.length > 0),
      b: z.number(),
    });
    const result = zodToJsonSchema(schema);
    expect(result).toHaveProperty('required', ['b']);
    expect(result).not.toHaveProperty('required', ['a']);
  });

  it('preserves .describe() on number/object/array fields (T22 fix — old impl dropped these)', () => {
    const schema = z.object({
      timeout: z.number().describe('Timeout in seconds'),
      options: z.array(z.string()).describe('Choices'),
      target: z.object({ path: z.string() }).describe('Where to write'),
    });
    expect(zodToJsonSchema(schema)).toEqual({
      type: 'object',
      properties: {
        timeout: { type: 'number', description: 'Timeout in seconds' },
        options: { type: 'array', items: { type: 'string' }, description: 'Choices' },
        target: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
          additionalProperties: false,
          description: 'Where to write',
        },
      },
      required: ['timeout', 'options', 'target'],
      additionalProperties: false,
      $schema: $S,
    });
  });
});

// ---------------------------------------------------------------------------
// ZodEffects (refine / transform)
// ---------------------------------------------------------------------------
describe('ZodEffects', () => {
  it('unwraps .refine() to inner schema', () => {
    const schema = z.string().refine((s) => s.length > 5);
    expect(zodToJsonSchema(schema)).toEqual({ type: 'string', $schema: $S });
  });

  it('unwraps .transform() to inner schema', () => {
    const schema = z.string().transform((s) => s.length);
    expect(zodToJsonSchema(schema)).toEqual({ type: 'string', $schema: $S });
  });

  it('unwraps chained refinements', () => {
    const schema = z
      .number()
      .refine((n) => n > 0)
      .refine((n) => n < 100);
    expect(zodToJsonSchema(schema)).toEqual({ type: 'number', $schema: $S });
  });

  it('unwraps refine on object schema', () => {
    const schema = z
      .object({ x: z.number() })
      .refine((data) => data.x > 0);
    expect(zodToJsonSchema(schema)).toEqual({
      type: 'object',
      properties: { x: { type: 'number' } },
      required: ['x'],
      additionalProperties: false,
      $schema: $S,
    });
  });
});

// ---------------------------------------------------------------------------
// ZodOptional
// ---------------------------------------------------------------------------
describe('ZodOptional', () => {
  it('unwraps optional string nested in an object', () => {
    const schema = z.object({ a: z.string().optional() });
    expect(zodToJsonSchema(schema)).toEqual({
      type: 'object',
      properties: { a: { type: 'string' } },
      additionalProperties: false,
      $schema: $S,
    });
  });

  it('renders a ROOT-level optional as anyOf with not:{} (maintained-package convention)', () => {
    // The handwritten converter unwrapped root optionals; zod-to-json-schema
    // keeps them representable via anyOf [{ not: {} }, <inner>].
    expect(zodToJsonSchema(z.string().optional())).toEqual({
      anyOf: [{ not: {} }, { type: 'string' }],
      $schema: $S,
    });
  });
});

// ---------------------------------------------------------------------------
// ZodDefault
// ---------------------------------------------------------------------------
describe('ZodDefault', () => {
  it('passes through literal default value', () => {
    const schema = z.string().default('hello');
    expect(zodToJsonSchema(schema)).toEqual({
      type: 'string',
      default: 'hello',
      $schema: $S,
    });
  });

  it('passes through function default value', () => {
    const schema = z.number().default(() => 42);
    expect(zodToJsonSchema(schema)).toEqual({
      type: 'number',
      default: 42,
      $schema: $S,
    });
  });

  it('wraps default on object fields', () => {
    const schema = z.object({
      role: z.string().default('user'),
    });
    const result = zodToJsonSchema(schema);
    expect(result).toEqual({
      type: 'object',
      properties: {
        role: { type: 'string', default: 'user' },
      },
      additionalProperties: false,
      $schema: $S,
    });
    // Default fields should not appear in required
    expect(result).not.toHaveProperty('required');
  });
});

// ---------------------------------------------------------------------------
// ZodNullable
// ---------------------------------------------------------------------------
describe('ZodNullable', () => {
  it('marks primitive schemas nullable via type array', () => {
    const schema = z.string().nullable();
    expect(zodToJsonSchema(schema)).toEqual({
      type: ['string', 'null'],
      $schema: $S,
    });
  });

  it('marks number schemas nullable via type array', () => {
    expect(zodToJsonSchema(z.number().nullable())).toEqual({
      type: ['number', 'null'],
      $schema: $S,
    });
  });

  it('marks object schemas nullable via anyOf with null branch', () => {
    const schema = z.object({ id: z.string() }).nullable();
    expect(zodToJsonSchema(schema)).toEqual({
      anyOf: [
        {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
          additionalProperties: false,
        },
        { type: 'null' },
      ],
      $schema: $S,
    });
  });

  it('keeps nullable nested field inside object properties', () => {
    const schema = z.object({
      data: z.object({ x: z.number() }).nullable(),
    });
    expect(zodToJsonSchema(schema)).toEqual({
      type: 'object',
      properties: {
        data: {
          anyOf: [
            {
              type: 'object',
              properties: { x: { type: 'number' } },
              required: ['x'],
              additionalProperties: false,
            },
            { type: 'null' },
          ],
        },
      },
      required: ['data'],
      additionalProperties: false,
      $schema: $S,
    });
  });
});

// ---------------------------------------------------------------------------
// ZodUnion
// ---------------------------------------------------------------------------
describe('ZodUnion', () => {
  it('collapses two scalar options into a type array', () => {
    const schema = z.union([z.string(), z.number()]);
    expect(zodToJsonSchema(schema)).toEqual({
      type: ['string', 'number'],
      $schema: $S,
    });
  });

  it('collapses three scalar options into a type array', () => {
    const schema = z.union([z.string(), z.number(), z.boolean()]);
    expect(zodToJsonSchema(schema)).toEqual({
      type: ['string', 'number', 'boolean'],
      $schema: $S,
    });
  });

  it('renders object unions as anyOf (was oneOf)', () => {
    const schema = z.union([
      z.object({ t: z.literal('a'), v: z.string() }),
      z.object({ t: z.literal('b'), n: z.number() }),
    ]);
    expect(zodToJsonSchema(schema)).toEqual({
      anyOf: [
        {
          type: 'object',
          properties: {
            t: { type: 'string', const: 'a' },
            v: { type: 'string' },
          },
          required: ['t', 'v'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: {
            t: { type: 'string', const: 'b' },
            n: { type: 'number' },
          },
          required: ['t', 'n'],
          additionalProperties: false,
        },
      ],
      $schema: $S,
    });
  });
});

// ---------------------------------------------------------------------------
// ZodLiteral
// ---------------------------------------------------------------------------
describe('ZodLiteral', () => {
  it('converts string literal', () => {
    expect(zodToJsonSchema(z.literal('hello'))).toEqual({
      type: 'string',
      const: 'hello',
      $schema: $S,
    });
  });

  it('converts number literal', () => {
    expect(zodToJsonSchema(z.literal(42))).toEqual({
      type: 'number',
      const: 42,
      $schema: $S,
    });
  });

  it('converts boolean literal', () => {
    expect(zodToJsonSchema(z.literal(true))).toEqual({
      type: 'boolean',
      const: true,
      $schema: $S,
    });
  });

  it('renders null literal as empty object schema (no const)', () => {
    // zod-to-json-schema has no const representation for null.
    expect(zodToJsonSchema(z.literal(null))).toEqual({
      type: 'object',
      $schema: $S,
    });
  });
});

// ---------------------------------------------------------------------------
// ZodRecord
// ---------------------------------------------------------------------------
describe('ZodRecord', () => {
  it('creates additionalProperties from value type', () => {
    const schema = z.record(z.string());
    expect(zodToJsonSchema(schema)).toEqual({
      type: 'object',
      additionalProperties: { type: 'string' },
      $schema: $S,
    });
  });

  it('handles record with number values', () => {
    const schema = z.record(z.number());
    expect(zodToJsonSchema(schema)).toEqual({
      type: 'object',
      additionalProperties: { type: 'number' },
      $schema: $S,
    });
  });

  it('handles record with object values', () => {
    const schema = z.record(
      z.object({ name: z.string(), count: z.number() }),
    );
    expect(zodToJsonSchema(schema)).toEqual({
      type: 'object',
      additionalProperties: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          count: { type: 'number' },
        },
        required: ['name', 'count'],
        additionalProperties: false,
      },
      $schema: $S,
    });
  });
});

// ---------------------------------------------------------------------------
// ZodTuple
// ---------------------------------------------------------------------------
describe('ZodTuple', () => {
  it('converts tuple to fixed-length array', () => {
    const schema = z.tuple([z.string(), z.number()]);
    expect(zodToJsonSchema(schema)).toEqual({
      type: 'array',
      items: [{ type: 'string' }, { type: 'number' }],
      minItems: 2,
      maxItems: 2,
      $schema: $S,
    });
  });

  it('converts single-element tuple', () => {
    const schema = z.tuple([z.boolean()]);
    expect(zodToJsonSchema(schema)).toEqual({
      type: 'array',
      items: [{ type: 'boolean' }],
      minItems: 1,
      maxItems: 1,
      $schema: $S,
    });
  });

  it('converts empty tuple', () => {
    const schema = z.tuple([]);
    expect(zodToJsonSchema(schema)).toEqual({
      type: 'array',
      items: [],
      minItems: 0,
      maxItems: 0,
      $schema: $S,
    });
  });
});

// ---------------------------------------------------------------------------
// Special types (Any, Unknown, fallback)
// ---------------------------------------------------------------------------
describe('special types', () => {
  it('ZodAny returns empty schema plus $schema', () => {
    expect(zodToJsonSchema(z.any())).toEqual({ $schema: $S });
  });

  it('ZodUnknown returns empty schema plus $schema', () => {
    expect(zodToJsonSchema(z.unknown())).toEqual({ $schema: $S });
  });

  it('ZodDate converts to string with date-time format', () => {
    expect(zodToJsonSchema(z.date())).toEqual({
      type: 'string',
      format: 'date-time',
      $schema: $S,
    });
  });

  it('ZodBigInt converts to integer with int64 format', () => {
    expect(zodToJsonSchema(z.bigint())).toEqual({
      type: 'integer',
      format: 'int64',
      $schema: $S,
    });
  });

  it('ZodIntersection converts to allOf', () => {
    const schema = z.intersection(z.object({ a: z.string() }), z.object({ b: z.number() }));
    expect(zodToJsonSchema(schema)).toEqual({
      allOf: [
        { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
        { type: 'object', properties: { b: { type: 'number' } }, required: ['b'] },
      ],
      $schema: $S,
    });
  });

  it('ZodMap converts to array of key/value entry tuples', () => {
    const schema = z.map(z.string(), z.number());
    expect(zodToJsonSchema(schema)).toMatchObject({
      type: 'array',
      items: {
        type: 'array',
        items: [{ type: 'string' }, { type: 'number' }],
        minItems: 2,
        maxItems: 2,
      },
    });
  });

  it('ZodSet converts to array with uniqueItems', () => {
    const schema = z.set(z.string());
    expect(zodToJsonSchema(schema)).toEqual({
      type: 'array',
      items: { type: 'string' },
      uniqueItems: true,
      $schema: $S,
    });
  });

  it('ZodPromise renders the awaited inner type', () => {
    expect(zodToJsonSchema(z.promise(z.string()))).toEqual({
      type: 'string',
      $schema: $S,
    });
  });
});

// ---------------------------------------------------------------------------
// Nested complex schemas
// ---------------------------------------------------------------------------
describe('nested complex schemas', () => {
  it('object with array of objects', () => {
    const ItemSchema = z.object({
      id: z.number(),
      name: z.string(),
    });
    const schema = z.object({
      items: z.array(ItemSchema),
    });
    expect(zodToJsonSchema(schema)).toEqual({
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'number' },
              name: { type: 'string' },
            },
            required: ['id', 'name'],
            additionalProperties: false,
          },
        },
      },
      required: ['items'],
      additionalProperties: false,
      $schema: $S,
    });
  });

  it('union of objects (discriminated-like) renders as anyOf', () => {
    const schema = z.union([
      z.object({ type: z.literal('a'), value: z.string() }),
      z.object({ type: z.literal('b'), count: z.number() }),
    ]);
    expect(zodToJsonSchema(schema)).toEqual({
      anyOf: [
        {
          type: 'object',
          properties: {
            type: { type: 'string', const: 'a' },
            value: { type: 'string' },
          },
          required: ['type', 'value'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: {
            type: { type: 'string', const: 'b' },
            count: { type: 'number' },
          },
          required: ['type', 'count'],
          additionalProperties: false,
        },
      ],
      $schema: $S,
    });
  });

  it('deeply nested: object > array > object > array > string', () => {
    const schema = z.object({
      outer: z.array(
        z.object({
          inner: z.array(z.string()),
        }),
      ),
    });
    expect(zodToJsonSchema(schema)).toEqual({
      type: 'object',
      properties: {
        outer: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              inner: {
                type: 'array',
                items: { type: 'string' },
              },
            },
            required: ['inner'],
            additionalProperties: false,
          },
        },
      },
      required: ['outer'],
      additionalProperties: false,
      $schema: $S,
    });
  });

  it('object with optional nested array', () => {
    const schema = z.object({
      tags: z.array(z.string()).optional(),
      name: z.string(),
    });
    const result = zodToJsonSchema(schema);
    expect(result).toEqual({
      type: 'object',
      properties: {
        tags: {
          type: 'array',
          items: { type: 'string' },
        },
        name: { type: 'string' },
      },
      required: ['name'],
      additionalProperties: false,
      $schema: $S,
    });
  });

  it('effect wrapping a complex object', () => {
    const schema = z
      .object({
        email: z.string().email(),
        age: z.number().int().min(0),
      })
      .refine((data) => data.age > 0);
    expect(zodToJsonSchema(schema)).toEqual({
      type: 'object',
      properties: {
        email: { type: 'string', format: 'email' },
        age: { type: 'integer', minimum: 0 },
      },
      required: ['email', 'age'],
      additionalProperties: false,
      $schema: $S,
    });
  });
});
