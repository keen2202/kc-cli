/**
 * LSP Tool heavy runtime — loaded lazily on first LSP invocation via dynamic import.
 *
 * This module contains everything that pulls in the DiagnosticCollector,
 * LSPClientManager, and language detection. None of these execute at
 * tool-registration time; they are deferred until the user actually invokes
 * the LSP tool.
 */

import { toolResult, toolError } from '../Tool';
import type { ToolResult as ToolResultType } from '../tools/protocol';
import type { ToolUseContext } from '../tools/protocol';
import { DiagnosticCollector } from './diagnostics';
import { LSPClientManager } from './client';
import type { LSPDiagnostic, LSPHover, LSPLocation } from './types';
import type { LSPInput } from './tool.js';

// Shared instances (module-level singletons within the impl)
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

export async function executeLsp(
  input: LSPInput,
  context: ToolUseContext,
  // Accepted for ToolDefinition.call conformance; LSP execution reports no
  // incremental progress.
  _onProgress?: (progress: unknown) => void,
): Promise<ToolResultType<string>> {
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
}
