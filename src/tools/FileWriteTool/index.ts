// File Write Tool

import { z } from 'zod';
import { buildTool, toolResult, toolError } from '../../Tool';
import type { ToolResult as ToolResultType } from '../protocol';
import type { PermissionResult } from '../../permissions/protocol';
import * as path from 'path';
import { assertPathWithinWorkspace } from '../../utils/path';

const FileWriteInputSchema = z.object({
  path: z.string().describe('File path to write'),
  content: z.string().describe('Content to write'),
  append: z.boolean().default(false).describe('Append to file instead of overwrite'),
});

type FileWriteInput = z.infer<typeof FileWriteInputSchema>;

export const tool = buildTool<FileWriteInput, string>({
  name: 'FileWrite',
  description: 'Write or create files',

  inputSchema: FileWriteInputSchema,

  call: async (input, context): Promise<ToolResultType<string>> => {
    try {
      const filePath = path.resolve(context.cwd, input.path);
      assertPathWithinWorkspace(input.path, context.cwd);

      // Ensure directory exists via ExecutionEnv abstraction
      const dir = path.dirname(filePath);
      await context.env.fs.mkdir(dir, { recursive: true });

      // Capture old content before write (for diff preview)
      let oldContent: string | null = null;
      if (!input.append) {
        oldContent = await context.env.fs.exists(filePath)
          ? await context.env.fs.readFile(filePath, 'utf-8')
          : null;
      }

      // Write file via ExecutionEnv abstraction
      let writeContent = input.content;
      if (input.append) {
        try {
          const existing = await context.env.fs.readFile(filePath, 'utf-8');
          writeContent = existing + input.content;
        } catch {
          // File doesn't exist yet, just write
        }
      }
      await context.env.fs.writeFile(filePath, writeContent);

      return toolResult(
        input.append
          ? `Appended ${input.content.length} bytes to ${filePath}`
          : `Wrote ${input.content.length} bytes to ${filePath}`,
        {
          metadata: {
            path: filePath,
            size: input.content.length,
            appended: input.append,
            oldContent,
            newContent: input.content,
          },
        }
      );
    } catch (error) {
      return toolError(`Failed to write file: ${error instanceof Error ? error.message : String(error)}`);
    }
  },

  checkPermissions: (input, context): PermissionResult => {
    return {
      behavior: 'ask',
      message: `Write to file: ${input.path} (${input.content.length} bytes)`,
    };
  },

  isReadOnly: () => false,
  isDestructive: (input) => !input.append,

  prompt: () => 'Write or create files. Supports append mode.',

  getToolUseSummary: (input) =>
    input.append
      ? `Appending to: ${input.path}`
      : `Writing: ${input.path}`,
  getActivityDescription: (input) =>
    input.append
      ? `Appending to file ${input.path}`
      : `Writing file ${input.path}`,
});
