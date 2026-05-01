# Tool Development Guide

## Creating a New Tool

### 1. Create the tool file

```typescript
// src/tools/MyTool/index.ts

import { z } from 'zod';
import { buildTool, toolResult, toolError } from '../../Tool';
import type { ToolResult } from '../../types/tools';
import type { PermissionResult } from '../../types/permissions';

const MyToolInputSchema = z.object({
  param1: z.string().describe('Description of param1'),
  param2: z.number().default(10).describe('Description of param2'),
});

type MyToolInput = z.infer<typeof MyToolInputSchema>;

export const tool = buildTool<MyToolInput, string>({
  name: 'MyTool',
  description: 'What this tool does',

  inputSchema: MyToolInputSchema,

  call: async (input, context): Promise<ToolResult<string>> => {
    try {
      // Tool logic here
      const result = `Processed ${input.param1}`;
      return toolResult(result);
    } catch (error) {
      return toolError(error instanceof Error ? error.message : 'Unknown error');
    }
  },

  checkPermissions: (input, context): PermissionResult => ({
    behavior: 'ask',
    message: `MyTool: ${input.param1}`,
  }),

  isReadOnly: (input) => true,
  isConcurrencySafe: () => true,
  isDestructive: () => false,

  prompt: () => 'Description for the LLM system prompt',
  getToolUseSummary: (input) => `MyTool(${input.param1})`,
  getActivityDescription: (input) => `Processing ${input.param1}`,
});
```

### 2. Register the tool

Add to `src/tools.ts`:
```typescript
import { tool as MyTool } from './tools/MyTool/index.js';
// Add to implementedTools array
```

### 3. Add to ToolName type

Add `'MyTool'` to the `ToolName` union in `src/types/tools.ts`.

## Tool Definition Interface

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| name | string | Yes | Unique tool name |
| description | string | Yes | What the tool does |
| inputSchema | ZodType | Yes | Input validation schema |
| call | function | Yes | Execution logic |
| checkPermissions | function | No | Permission evaluation |
| isReadOnly | function | No | Whether tool modifies state |
| isConcurrencySafe | function | No | Whether tool can run in parallel |
| isDestructive | function | No | Whether tool has irreversible effects |
| prompt | function | No | LLM system prompt hint |

## Permission Behaviors

- `allow` -- Execute without asking
- `ask` -- Prompt user for permission
- `deny` -- Block execution
- `passthrough` -- Delegate to parent rules

## Testing Tools

Use vitest to test tools:
```typescript
import { describe, it, expect } from 'vitest';
import { tool } from '../src/tools/MyTool/index';

describe('MyTool', () => {
  it('should process input', async () => {
    const result = await tool.call(
      { param1: 'test', param2: 5 },
      { cwd: '/tmp', abortController: new AbortController(), permissions: {} as any }
    );
    expect(result.isError).toBe(false);
    expect(result.output).toContain('test');
  });
});
```
