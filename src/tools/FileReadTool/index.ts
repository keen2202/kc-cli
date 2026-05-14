// File Read Tool

import { z } from 'zod';
import { buildTool, toolResult, toolError } from '../../Tool';
import type { ToolResult as ToolResultType } from '../../types/tools';
import type { PermissionResult } from '../../types/permissions';
import * as path from 'path';
import * as fs from 'fs';
import { assertPathWithinWorkspace } from '../../utils/path';

const FileReadInputSchema = z.object({
  path: z.string().describe('File path to read'),
  range: z.object({
    start: z.number().optional(),
    end: z.number().optional(),
  }).optional().describe('Line range to read'),
  maxSize: z.number().default(100000).describe('Max bytes to read'),
});

type FileReadInput = z.infer<typeof FileReadInputSchema>;

export const tool = buildTool<FileReadInput, string>({
  name: 'FileRead',
  description: 'Read file contents',

  inputSchema: FileReadInputSchema,

  call: async (input, context): Promise<ToolResultType<string>> => {
    try {
      const filePath = path.resolve(context.cwd, input.path);
      assertPathWithinWorkspace(input.path, context.cwd);

      // Check file exists (async)
      try {
        await fs.promises.access(filePath);
      } catch {
        return toolError(`File not found: ${filePath}`);
      }

      // Check file size (async)
      const stat = await fs.promises.stat(filePath);
      if (stat.size > input.maxSize) {
        return toolError(
          `File too large (${stat.size} bytes). Max: ${input.maxSize} bytes`
        );
      }

      // Read file
      let content = await fs.promises.readFile(filePath, 'utf-8');

      // Apply range if specified
      if (input.range) {
        const lines = content.split('\n');
        const start = input.range.start ?? 0;
        const end = input.range.end ?? lines.length;
        content = lines.slice(start, end).join('\n');
      }

      return toolResult(content, {
        metadata: {
          path: filePath,
          size: stat.size,
          lines: content.split('\n').length,
        },
      });
    } catch (error) {
      return toolError(`Failed to read file: ${error instanceof Error ? error.message : String(error)}`);
    }
  },

  checkPermissions: (input, context): PermissionResult => {
    // Read-only by default
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'readonly',
        reason: 'File read is read-only operation',
      },
    };
  },

  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  prompt: () => 'Read file contents. Supports line ranges.',

  getToolUseSummary: (input) => `Reading: ${input.path}`,
  getActivityDescription: (input) => `Reading file ${input.path}`,
});
