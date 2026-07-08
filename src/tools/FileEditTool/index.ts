// File Edit Tool - Patch/edit files with search-replace or line operations

import { z } from 'zod';
import { buildTool, toolResult, toolError } from '../../Tool';
import type { ToolResult as ToolResultType } from '../protocol';
import type { PermissionResult } from '../../permissions/protocol';
import * as path from 'path';
import { assertPathWithinWorkspace } from '../../utils/path';
import { isExecError, getErrorMessage, getErrorStack } from '../../utils/errors';

const FileEditInputSchema = z.object({
  file_path: z.string().describe('Path to file to edit'),
  edits: z.array(z.object({
    old_string: z.string().describe('Text to find'),
    new_string: z.string().describe('Text to replace with'),
    replace_all: z.boolean().default(false).describe('Replace all occurrences'),
  })).min(1).describe('List of edits to apply'),
  dry_run: z.boolean().default(false).describe('Preview changes without applying'),
});

type FileEditInput = z.infer<typeof FileEditInputSchema>;

export const tool = buildTool<FileEditInput, string>({
  name: 'FileEdit',
  description: 'Edit files with search-replace operations',

  inputSchema: FileEditInputSchema,

  call: async (input, context): Promise<ToolResultType<string>> => {
    try {
      const filePath = path.resolve(context.cwd, input.file_path);
      assertPathWithinWorkspace(input.file_path, context.cwd);

      // Check file exists via ExecutionEnv abstraction
      if (!(await context.env.fs.exists(filePath))) {
        return toolError(`File not found: ${filePath}`);
      }

      // Read file via ExecutionEnv abstraction
      let content = await context.env.fs.readFile(filePath, 'utf-8');
      const originalContent = content;
      const changes: string[] = [];

      // Apply edits
      for (const edit of input.edits) {
        if (edit.replace_all) {
          const count = (content.match(new RegExp(edit.old_string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
          content = content.split(edit.old_string).join(edit.new_string);
          changes.push(`Replaced ${count} occurrences of "${edit.old_string.slice(0, 50)}..."`);
        } else {
          if (content.includes(edit.old_string)) {
            content = content.replace(edit.old_string, edit.new_string);
            changes.push(`Replaced "${edit.old_string.slice(0, 50)}..."`);
          } else {
            return toolError(`String not found: "${edit.old_string.slice(0, 50)}..."`);
          }
        }
      }

      // Dry run - just show changes
      if (input.dry_run) {
        const diff = changes.join('\n');
        return toolResult(`Dry run - changes:\n${diff}`, {
          metadata: { filePath, changes: changes.length },
        });
      }

      // Write file via ExecutionEnv abstraction
      await context.env.fs.writeFile(filePath, content);

      return toolResult(
        `Applied ${changes.length} edit(s) to ${input.file_path}:\n${changes.join('\n')}`,
        {
          metadata: {
            file_path: filePath,
            changes: changes.length,
            original_size: originalContent.length,
            new_size: content.length,
            oldContent: originalContent,
            newContent: content,
          },
        }
      );
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      const metadata: Record<string, unknown> = {};

      // Preserve stack trace information
      const errorStack = getErrorStack(error);
      if (errorStack) {
        metadata.stack = errorStack;
      }

      // Preserve exec error info (exitCode, signal, stderr) when applicable
      if (isExecError(error)) {
        if (error.code !== undefined) metadata.exitCode = error.code;
        if (error.signal !== undefined) metadata.signal = error.signal;
        if (error.stderr !== undefined) metadata.stderr = error.stderr;
      }

      return toolError(`File edit failed: ${errorMessage}`, metadata);
    }
  },

  checkPermissions: (input, context): PermissionResult => {
    if (input.dry_run) {
      return {
        behavior: 'allow',
        updatedInput: input,
        decisionReason: { type: 'readonly', reason: 'Dry run is read-only' },
      };
    }

    return {
      behavior: 'ask',
      message: `Edit file: ${input.file_path} (${input.edits.length} changes)`,
    };
  },

  isReadOnly: (input) => input.dry_run,
  isConcurrencySafe: () => false,
  isDestructive: (input) => !input.dry_run,

  prompt: () => 'Edit files with search-replace. Supports dry run.',

  getToolUseSummary: (input) =>
    input.dry_run
      ? `Dry run edit: ${input.file_path}`
      : `Editing: ${input.file_path} (${input.edits.length} changes)`,
  getActivityDescription: (input) =>
    input.dry_run
      ? `Previewing edits to ${input.file_path}`
      : `Editing ${input.file_path}`,
});
