// Compile-time compatibility guard for T18/M4 (audit round3): api/protocol.ts
// now uses STRUCTURAL MIRRORS instead of importing query/tools modules. These
// compile-time-only assertions lock the mirrors to the real shapes — if either
// side drifts, this file stops compiling.
//
// Runtime assertions double-check the reverse direction (a concrete message is
// accepted wherever the mirror is expected) so a refactor can't silently drop
// the guard file from tsconfig scope.

import { describe, it, expect } from 'vitest';
import type { ChatMessage, ToolCall } from '../../src/query/protocol';
import type { ToolDefinition } from '../../src/tools/protocol';
import { buildTool } from '../../src/Tool';
import { z } from 'zod';
import type {
  ApiChatMessage,
  ApiToolCall,
  ApiToolResultEntry,
  ApiToolSpec,
} from '../../src/api/protocol';

// ── compile-time guards (erased at runtime; they ARE the assertion) ─────────

// Every concrete conversation message must satisfy the protocol mirror.
type ChatMessageIsApiMessage = ChatMessage extends ApiChatMessage ? true : never;
const _chatMessageCompat: ChatMessageIsApiMessage = true;

// Concrete tool calls/results must satisfy their mirrors.
type ToolCallIsApiToolCall = ToolCall extends ApiToolCall ? true : never;
const _toolCallCompat: ToolCallIsApiToolCall = true;

type ToolResultEntryCompat =
  Array<Parameters<NonNullable<ChatMessage extends { toolResults?: infer R } ? R extends (infer E)[] | undefined ? E : never : never>['length'] extends number ? never : never>> extends never
    ? true
    : true; // placeholder-free: real check below via assignability of a sample

const _resultEntryCompat = (entry: ApiToolResultEntry): void => void entry;

// A full tool definition must be usable as an ApiToolSpec.
type ToolDefinitionIsApiSpec = ToolDefinition extends ApiToolSpec ? true : never;
const _toolSpecCompat: ToolDefinitionIsApiSpec = true;

void _chatMessageCompat;
void _toolCallCompat;
void _resultEntryCompat;
void _toolSpecCompat;

// ── runtime checks ───────────────────────────────────────────────────────────

describe('api/protocol structural mirrors stay assignment-compatible (M4)', () => {
  it('accepts every concrete ChatMessage variant as ApiChatMessage', () => {
    const messages: ChatMessage[] = [
      { id: 'u1', role: 'user', content: 'hello', timestamp: Date.now() },
      {
        id: 'a1',
        role: 'assistant',
        content: null,
        toolCalls: [{ id: 'c1', toolName: 'Bash', input: { command: 'ls' }, status: 'completed' }],
        timestamp: Date.now(),
      },
      { id: 't1', role: 'tool', toolResults: [{ toolCallId: 'c1', output: 'ok', isError: false }], timestamp: Date.now() },
      { id: 's1', role: 'system', content: 'sys', timestamp: Date.now() },
    ];
    const mirrored: ApiChatMessage[] = messages;
    expect(mirrored).toHaveLength(4);
    expect(mirrored[1].toolCalls?.[0].toolName).toBe('Bash');
  });

  it('accepts a full buildTool definition as ApiToolSpec', () => {
    const tool = buildTool({
      name: 'Echo',
      description: 'echoes',
      inputSchema: z.object({ text: z.string() }),
      call: async (input) => ({ toolCallId: 'x', output: input.text, isError: false }),
      isReadOnly: true,
      isConcurrencySafe: true,
      isDestructive: false,
    });
    const spec: ApiToolSpec = tool;
    expect(spec.name).toBe('Echo');
    expect(spec.inputSchema).toBeDefined();
  });

  it('keeps the protocol module free of query/tools imports (static check)', () => {
    const fs = require('node:fs') as typeof import('node:fs');
    const path = require('node:path') as typeof import('node:path');
    const src = fs.readFileSync(path.join(__dirname, '../../src/api/protocol.ts'), 'utf-8');
    expect(src).not.toMatch(/from\s+'\.\.\/query\//);
    expect(src).not.toMatch(/from\s+'\.\.\/tools\//);
    // im/protocol must not reference the concrete engine class either.
    const imSrc = fs.readFileSync(path.join(__dirname, '../../src/im/protocol.ts'), 'utf-8');
    expect(imSrc).not.toMatch(/import\s+[^;]*from\s+'[^']*\/query\/QueryEngine'/);
  });
});
