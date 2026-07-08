// Zod to JSON Schema converter
// Converts Zod schemas to JSON Schema format for LLM tool definitions

import { z } from 'zod';

/**
 * Convert a Zod schema to JSON Schema format
 * Supports the most common Zod types used in tool definitions
 */
export function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  return convertSchema(schema);
}

function convertSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  // Handle ZodEffects (from .refine(), .transform(), etc.)
  if (schema._def.typeName === 'ZodEffects') {
    const innerSchema = (schema as z.ZodEffects<any>)._def.schema;
    return convertSchema(innerSchema);
  }

  // Handle ZodOptional
  if (schema._def.typeName === 'ZodOptional') {
    const innerSchema = (schema as z.ZodOptional<any>)._def.innerType;
    return convertSchema(innerSchema);
  }

  // Handle ZodDefault
  if (schema._def.typeName === 'ZodDefault') {
    const innerSchema = (schema as z.ZodDefault<any>)._def.innerType;
    const result = convertSchema(innerSchema);
    result.default = (schema as z.ZodDefault<any>)._def.defaultValue();
    return result;
  }

  // Handle ZodNullable
  if (schema._def.typeName === 'ZodNullable') {
    const innerSchema = (schema as z.ZodNullable<any>)._def.innerType;
    const result = convertSchema(innerSchema);
    result.nullable = true;
    return result;
  }

  // Handle ZodObject
  if (schema._def.typeName === 'ZodObject') {
    return convertObject(schema as z.ZodObject<any>);
  }

  // Handle ZodArray
  if (schema._def.typeName === 'ZodArray') {
    return convertArray(schema as z.ZodArray<any>);
  }

  // Handle ZodString
  if (schema._def.typeName === 'ZodString') {
    return convertString(schema as z.ZodString);
  }

  // Handle ZodNumber
  if (schema._def.typeName === 'ZodNumber') {
    return convertNumber(schema as z.ZodNumber);
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
      oneOf: options.map((opt: z.ZodTypeAny) => convertSchema(opt)),
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
      additionalProperties: convertSchema((schema as z.ZodRecord<any, any>)._def.valueType),
    };
  }

  // Handle ZodTuple
  if (schema._def.typeName === 'ZodTuple') {
    const items = (schema as z.ZodTuple<any>)._def.items;
    return {
      type: 'array',
      items: items.map((item: z.ZodTypeAny) => convertSchema(item)),
      minItems: items.length,
      maxItems: items.length,
    };
  }

  // Handle ZodAny / ZodUnknown
  if (schema._def.typeName === 'ZodAny' || schema._def.typeName === 'ZodUnknown') {
    return {};
  }

  // Fallback for unsupported types
  return { type: 'object' };
}

function convertObject(schema: z.ZodObject<any>): Record<string, unknown> {
  const shape = schema.shape;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, value] of Object.entries(shape)) {
    const fieldSchema = value as z.ZodTypeAny;
    properties[key] = convertSchema(fieldSchema);

    // Check if field is required (not optional)
    if (!isOptional(fieldSchema)) {
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

function convertArray(schema: z.ZodArray<any>): Record<string, unknown> {
  const result: Record<string, unknown> = {
    type: 'array',
    items: convertSchema(schema._def.type),
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

function convertString(schema: z.ZodString): Record<string, unknown> {
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

function convertNumber(schema: z.ZodNumber): Record<string, unknown> {
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

function isOptional(schema: z.ZodTypeAny): boolean {
  if (schema._def.typeName === 'ZodOptional') return true;
  if (schema._def.typeName === 'ZodDefault') return true;
  return false;
}
