// LSP Tool - Exposes LSP functionality as an agent-accessible tool

import { z } from 'zod';
import { buildTool, toolResult, toolError } from '../Tool';
import type { ToolResult as ToolResultType } from '../tools/protocol';
import type { PermissionResult } from '../permissions/protocol';
import { DiagnosticCollector } from './diagnostics';
import { LSPClientManager, detectLanguage } from './client';
import type { LSPDiagnostic, LSPHover, LSPLocation } from './types';

const LSPInputSchema = z.object({
  action: z.enum(['diagnostics', 'hover', 'definition']).describe('LSP action to perform'),
  filePath: z.string().describe('Path to the file'),
  line: z.number().optional().describe('Line number (0-indexed, for hover/definition)'),
  character: z.number().optional().describe('Character position (0-indexed, for hover/definition)'),
  content: z.string().optional().describe('File content (for diagnostics)'),
  severity: z.enum(['all', 'errors', 'warnings']).default('all').describe('Diagnostic severity filter'),
});

type LSPInput = z.infer<typeof LSPInputSchema>;

// Shared instances
let clientManager: LSPClientManager | null = null;
let diagnosticCollector: DiagnosticCollector | null = null;

function getClientManager(): LSPClientManager {
  if (!clientManager) {
    clientManager = new LSPClientManager();
  }
  return clientManager;
}

function getDiagnosticCollector(): DiagnosticCollector {
  if (!diagnosticCollector) {
    diagnosticCollector = new DiagnosticCollector(getClientManager());
  }
  return diagnosticCollector;
}

function formatDiagnostic(d: LSPDiagnostic): string {
  const severityMap: Record<number, string> = { 1: 'Error', 2: 'Warning', 3: 'Info', 4: 'Hint' };
  const severity = severityMap[d.severity] || 'Unknown';
  const range = `${d.range.start.line}:${d.range.start.character}-${d.range.end.line}:${d.range.end.character}`;
  const source = d.source ? ` [${d.source}]` : '';
  const code = d.code ? ` (${d.code})` : '';
  return `[${severity}]${source}${code} ${range}: ${d.message}`;
}

function formatHover(hover: LSPHover): string {
  const content = typeof hover.contents === 'string' ? hover.contents : hover.contents.value;
  return content;
}

function formatLocation(loc: LSPLocation): string {
  const filePath = loc.uri.replace('file://', '');
  return `${filePath}:${loc.range.start.line}:${loc.range.start.character}`;
}

export const tool = buildTool<LSPInput, string>({
  name: 'LSP',
  description: 'Language Server Protocol tool - get diagnostics, hover info, or go-to-definition for code files',

  inputSchema: LSPInputSchema,

  call: async (input, context): Promise<ToolResultType<string>> => {
    try {
      const filePath = input.filePath.startsWith('/')
        ? input.filePath
        : `${context.cwd}/${input.filePath}`;

      switch (input.action) {
        case 'diagnostics': {
          const collector = getDiagnosticCollector();
          const diagnostics = await collector.getDiagnosticsForFile(filePath, input.content);

          if (diagnostics.length === 0) {
            return toolResult('No diagnostics found.', {
              metadata: { filePath, count: 0 },
            });
          }

          const filtered = input.severity === 'all'
            ? diagnostics
            : diagnostics.filter(d => {
                if (input.severity === 'errors') return d.severity === 1;
                if (input.severity === 'warnings') return d.severity === 1 || d.severity === 2;
                return true;
              });

          const formatted = filtered.map(formatDiagnostic).join('\n');
          return toolResult(formatted, {
            metadata: { filePath, count: filtered.length, severity: input.severity },
          });
        }

        case 'hover': {
          if (input.line === undefined || input.character === undefined) {
            return toolError('hover action requires line and character parameters');
          }

          const manager = getClientManager();
          const content = input.content || '';
          const hover = await manager.getHover(filePath, content, input.line, input.character);

          if (!hover) {
            return toolResult('No hover information available.', {
              metadata: { filePath, line: input.line, character: input.character },
            });
          }

          return toolResult(formatHover(hover), {
            metadata: { filePath, line: input.line, character: input.character },
          });
        }

        case 'definition': {
          if (input.line === undefined || input.character === undefined) {
            return toolError('definition action requires line and character parameters');
          }

          const manager = getClientManager();
          const content = input.content || '';
          const locations = await manager.getDefinition(filePath, content, input.line, input.character);

          if (locations.length === 0) {
            return toolResult('No definition found.', {
              metadata: { filePath, line: input.line, character: input.character },
            });
          }

          const formatted = locations.map(formatLocation).join('\n');
          return toolResult(formatted, {
            metadata: { filePath, count: locations.length },
          });
        }

        default:
          return toolError(`Unknown LSP action: ${input.action}`);
      }
    } catch (error) {
      return toolError(`LSP error: ${error instanceof Error ? error.message : String(error)}`);
    }
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
