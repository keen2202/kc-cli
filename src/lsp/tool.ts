// LSP Tool - Lightweight entry: schema + metadata + permission check + delegating call.
// Heavy runtime (DiagnosticCollector, LSPClientManager, detectLanguage) is deferred to
// tool-impl.ts and loaded on first LSP invocation via dynamic import.

import { z } from 'zod';
import { buildTool } from '../Tool';
import type { PermissionResult } from '../permissions/protocol';

const LSPInputSchema = z.object({
  action: z.enum(['diagnostics', 'hover', 'definition']).describe('LSP action to perform'),
  filePath: z.string().describe('Path to the file'),
  line: z.number().optional().describe('Line number (0-indexed, for hover/definition)'),
  character: z.number().optional().describe('Character position (0-indexed, for hover/definition)'),
  content: z.string().optional().describe('File content (for diagnostics)'),
  severity: z.enum(['all', 'errors', 'warnings']).default('all').describe('Diagnostic severity filter'),
});

export type LSPInput = z.infer<typeof LSPInputSchema>;

export const tool = buildTool<LSPInput, string>({
  name: 'LSP',
  description: 'Language Server Protocol tool - get diagnostics, hover info, or go-to-definition for code files',

  inputSchema: LSPInputSchema,

  call: async (input, context, onProgress) => {
    const { executeLsp } = await import('./tool-impl.js');
    return executeLsp(input, context, onProgress);
  },

  checkPermissions: (input): PermissionResult => ({
    behavior: 'allow',
    updatedInput: input,
    decisionReason: { type: 'readonly', reason: 'LSP tool is read-only' },
  }),

  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  prompt: () => 'Query language servers for diagnostics, hover information, or go-to-definition.',

  getToolUseSummary: (input) => `LSP ${input.action}: ${input.filePath}`,
  getActivityDescription: (input) => `Querying LSP for ${input.action} on ${input.filePath}`,
});
