import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { zodToJsonSchema } from '../../src/utils/zodToJsonSchema';

// ---------------------------------------------------------------------------
// Basic types
// ---------------------------------------------------------------------------
describe('basic types', () => {
  it('converts ZodString', () => {
    expect(zodToJsonSchema(z.string())).toEqual({ type: 'string' });
  });

  it('converts ZodNumber', () => {
    expect(zodToJsonSchema(z.number())).toEqual({ type: 'number' });
  });

  it('converts ZodBoolean', () => {
    expect(zodToJsonSchema(z.boolean())).toEqual({ type: 'boolean' });
  });

  it('converts ZodEnum', () => {
    const schema = z.enum(['a', 'b', 'c']);
    expect(zodToJsonSchema(schema)).toEqual({
      type: 'string',
      enum: ['a', 'b', 'c'],
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
    });
  });

  it('converts ZodNativeEnum (numeric enum)', () => {
    enum Dir {
      Up,
      Down,
    }
    const schema = z.nativeEnum(Dir);
    const result = zodToJsonSchema(schema);
    expect(result).toMatchObject({ type: 'string' });
    // Numeric enums have reverse-mapping entries
    expect(Array.isArray(result.enum)).toBe(true);
    expect(result.enum).toContain(0);
    expect(result.enum).toContain(1);
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
    });
  });

  it('adds email format', () => {
    expect(zodToJsonSchema(z.string().email())).toEqual({
      type: 'string',
      format: 'email',
    });
  });

  it('adds uri format', () => {
    expect(zodToJsonSchema(z.string().url())).toEqual({
      type: 'string',
      format: 'uri',
    });
  });

  it('adds uuid format', () => {
    expect(zodToJsonSchema(z.string().uuid())).toEqual({
      type: 'string',
      format: 'uuid',
    });
  });

  it('adds date-time format', () => {
    expect(zodToJsonSchema(z.string().datetime())).toEqual({
      type: 'string',
      format: 'date-time',
    });
  });

  it('adds pattern from regex', () => {
    expect(zodToJsonSchema(z.string().regex(/^[a-z]+$/))).toEqual({
      type: 'string',
      pattern: '^[a-z]+$',
    });
  });

  it('adds description', () => {
    expect(zodToJsonSchema(z.string().describe('A username'))).toEqual({
      type: 'string',
      description: 'A username',
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
    });
  });

  it('handles string with no checks', () => {
    expect(zodToJsonSchema(z.string())).toEqual({ type: 'string' });
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
    });
  });

  it('adds exclusive minimum (gt)', () => {
    // `.gt()` creates a check with inclusive:false
    expect(zodToJsonSchema(z.number().gt(0))).toEqual({
      type: 'number',
      exclusiveMinimum: 0,
    });
  });

  it('adds exclusive maximum (lt)', () => {
    // `.lt()` creates a check with inclusive:false
    expect(zodToJsonSchema(z.number().lt(100))).toEqual({
      type: 'number',
      exclusiveMaximum: 100,
    });
  });

  it('adds int type', () => {
    expect(zodToJsonSchema(z.number().int())).toEqual({
      type: 'integer',
    });
  });

  it('combines multiple number constraints', () => {
    const schema = z.number().gt(0).lt(100).int();
    expect(zodToJsonSchema(schema)).toEqual({
      type: 'integer',
      exclusiveMinimum: 0,
      exclusiveMaximum: 100,
    });
  });

  it('handles number with no checks', () => {
    expect(zodToJsonSchema(z.number())).toEqual({ type: 'number' });
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
    });
  });

  it('calls min() but minItems is not emitted (Zod 3.23+ stores minLength on def, not in checks array)', () => {
    // The source accesses schema._def.checks which is undefined in Zod 3.23+
    expect(zodToJsonSchema(z.array(z.number()).min(1))).toEqual({
      type: 'array',
      items: { type: 'number' },
    });
  });

  it('calls max() but maxItems is not emitted (Zod 3.23+ stores maxLength on def, not in checks array)', () => {
    expect(zodToJsonSchema(z.array(z.boolean()).max(5))).toEqual({
      type: 'array',
      items: { type: 'boolean' },
    });
  });

  it('calls min().max() but neither is emitted for the same reason', () => {
    const schema = z.array(z.string()).min(2).max(10);
    expect(zodToJsonSchema(schema)).toEqual({
      type: 'array',
      items: { type: 'string' },
    });
  });

  it('handles array with no constraints', () => {
    expect(zodToJsonSchema(z.array(z.any()))).toEqual({
      type: 'array',
      items: {},
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
        },
      },
      required: ['meta'],
    });
  });

  it('treats ZodDefault fields as optional (not required)', () => {
    // isOptional returns true for ZodDefault (line 245)
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
});

// ---------------------------------------------------------------------------
// ZodEffects (refine / transform)
// ---------------------------------------------------------------------------
describe('ZodEffects', () => {
  it('unwraps .refine() to inner schema', () => {
    const schema = z.string().refine((s) => s.length > 5);
    expect(zodToJsonSchema(schema)).toEqual({ type: 'string' });
  });

  it('unwraps .transform() to inner schema', () => {
    const schema = z.string().transform((s) => s.length);
    expect(zodToJsonSchema(schema)).toEqual({ type: 'string' });
  });

  it('unwraps chained refinements', () => {
    const schema = z
      .number()
      .refine((n) => n > 0)
      .refine((n) => n < 100);
    expect(zodToJsonSchema(schema)).toEqual({ type: 'number' });
  });

  it('unwraps refine on object schema', () => {
    const schema = z
      .object({ x: z.number() })
      .refine((data) => data.x > 0);
    expect(zodToJsonSchema(schema)).toEqual({
      type: 'object',
      properties: { x: { type: 'number' } },
      required: ['x'],
    });
  });
});

// ---------------------------------------------------------------------------
// ZodOptional
// ---------------------------------------------------------------------------
describe('ZodOptional', () => {
  it('unwraps optional string', () => {
    expect(zodToJsonSchema(z.string().optional())).toEqual({
      type: 'string',
    });
  });

  it('unwraps optional number', () => {
    expect(zodToJsonSchema(z.number().optional())).toEqual({
      type: 'number',
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
    });
  });

  it('passes through function default value', () => {
    const schema = z.number().default(() => 42);
    expect(zodToJsonSchema(schema)).toEqual({
      type: 'number',
      default: 42,
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
    });
    // Default fields should not appear in required
    expect(result).not.toHaveProperty('required');
  });
});

// ---------------------------------------------------------------------------
// ZodNullable
// ---------------------------------------------------------------------------
describe('ZodNullable', () => {
  it('marks schema as nullable', () => {
    const schema = z.string().nullable();
    expect(zodToJsonSchema(schema)).toEqual({
      type: 'string',
      nullable: true,
    });
  });

  it('unwraps nullable number', () => {
    expect(zodToJsonSchema(z.number().nullable())).toEqual({
      type: 'number',
      nullable: true,
    });
  });

  it('unwraps nullable object', () => {
    const schema = z.object({ id: z.string() }).nullable();
    expect(zodToJsonSchema(schema)).toEqual({
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      nullable: true,
    });
  });
});

// ---------------------------------------------------------------------------
// ZodUnion
// ---------------------------------------------------------------------------
describe('ZodUnion', () => {
  it('creates oneOf with two options', () => {
    const schema = z.union([z.string(), z.number()]);
    expect(zodToJsonSchema(schema)).toEqual({
      oneOf: [{ type: 'string' }, { type: 'number' }],
    });
  });

  it('creates oneOf with three options', () => {
    const schema = z.union([z.string(), z.number(), z.boolean()]);
    expect(zodToJsonSchema(schema)).toEqual({
      oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }],
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
    });
  });

  it('converts number literal', () => {
    expect(zodToJsonSchema(z.literal(42))).toEqual({
      type: 'number',
      const: 42,
    });
  });

  it('converts boolean literal', () => {
    expect(zodToJsonSchema(z.literal(true))).toEqual({
      type: 'boolean',
      const: true,
    });
  });

  it('converts null literal', () => {
    expect(zodToJsonSchema(z.literal(null))).toEqual({
      type: 'object',
      const: null,
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
    });
  });

  it('handles record with number values', () => {
    const schema = z.record(z.number());
    expect(zodToJsonSchema(schema)).toEqual({
      type: 'object',
      additionalProperties: { type: 'number' },
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
      },
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
    });
  });

  it('converts single-element tuple', () => {
    const schema = z.tuple([z.boolean()]);
    expect(zodToJsonSchema(schema)).toEqual({
      type: 'array',
      items: [{ type: 'boolean' }],
      minItems: 1,
      maxItems: 1,
    });
  });

  it('converts empty tuple', () => {
    const schema = z.tuple([]);
    expect(zodToJsonSchema(schema)).toEqual({
      type: 'array',
      items: [],
      minItems: 0,
      maxItems: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// Special types (Any, Unknown, fallback)
// ---------------------------------------------------------------------------
describe('special types', () => {
  it('ZodAny returns empty object', () => {
    expect(zodToJsonSchema(z.any())).toEqual({});
  });

  it('ZodUnknown returns empty object', () => {
    expect(zodToJsonSchema(z.unknown())).toEqual({});
  });

  it('unsupported type falls back to { type: "object" }', () => {
    // ZodDate is not handled by the converter
    expect(zodToJsonSchema(z.date())).toEqual({ type: 'object' });
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
          },
        },
      },
      required: ['items'],
    });
  });

  it('union of objects (discriminated-like)', () => {
    const schema = z.union([
      z.object({ type: z.literal('a'), value: z.string() }),
      z.object({ type: z.literal('b'), count: z.number() }),
    ]);
    expect(zodToJsonSchema(schema)).toEqual({
      oneOf: [
        {
          type: 'object',
          properties: {
            type: { type: 'string', const: 'a' },
            value: { type: 'string' },
          },
          required: ['type', 'value'],
        },
        {
          type: 'object',
          properties: {
            type: { type: 'string', const: 'b' },
            count: { type: 'number' },
          },
          required: ['type', 'count'],
        },
      ],
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
          },
        },
      },
      required: ['outer'],
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
    });
  });

  it('object with nullable nested field', () => {
    const schema = z.object({
      data: z
        .object({ x: z.number() })
        .nullable(),
    });
    expect(zodToJsonSchema(schema)).toEqual({
      type: 'object',
      properties: {
        data: {
          type: 'object',
          properties: { x: { type: 'number' } },
          required: ['x'],
          nullable: true,
        },
      },
      required: ['data'],
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
    });
  });
});
