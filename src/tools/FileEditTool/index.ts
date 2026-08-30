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

/** Snapshot used to detect that the file changed between read and write. */
interface FileStamp {
  mtimeMs: number;
  size: number;
}

/**
 * The read-modify-write cycle, extracted so it can run under the file lock.
 *
 * Phase A (optimistic concurrency): the file's mtime+size are captured when it
 * is read and re-checked immediately before the write. If they differ, someone
 * else changed the file underneath us — return a conflict error and let the
 * caller re-read and retry, instead of silently discarding their edit.
 */
async function applyEdits(
  input: FileEditInput,
  context: import('../protocol').ToolUseContext,
  filePath: string,
): Promise<ToolResultType<string>> {
  // Check file exists via ExecutionEnv abstraction
  if (!(await context.env.fs.exists(filePath))) {
    return toolError(`File not found: ${filePath}`);
  }

  // Read file via ExecutionEnv abstraction
  let stamp: FileStamp | null = null;
  try {
    const stats = await context.env.fs.stat(filePath);
    stamp = { mtimeMs: stats.mtime.getTime(), size: stats.size };
  } catch {
    // stat is best-effort: without a stamp we simply skip the conflict check.
    stamp = null;
  }

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

  // Conflict check: the file must still be the one we read.
  if (stamp) {
    const current = await context.env.fs.stat(filePath).catch(() => null);
    if (
      current &&
      (current.mtime.getTime() !== stamp.mtimeMs || current.size !== stamp.size)
    ) {
      return toolError(
        `File changed while editing (${input.file_path}): it was modified after ` +
          `this edit was prepared. Re-read the file and retry the edit.`,
        { file_path: filePath, conflict: true },
      );
    }
  }

  // T2 (H2): atomic write with a best-effort timestamped backup so a
  // crash mid-write cannot truncate the target and the pre-edit content is
  // recoverable (backupPath feeds T3 undo + UI diff/restore).
  const { backupPath, backupFailed } = await context.env.fs.writeFileAtomic(
    filePath,
    content,
    { cwd: context.cwd },
  );

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
        backupPath,
        backupFailed,
      },
    }
  );
}

export const tool = buildTool<FileEditInput, string>({
  name: 'FileEdit',
  description: 'Edit files with search-replace operations',

  inputSchema: FileEditInputSchema,

  call: async (input, context): Promise<ToolResultType<string>> => {
    try {
      const filePath = path.resolve(context.cwd, input.file_path);
      assertPathWithinWorkspace(input.file_path, context.cwd);

      // R1: the read-modify-write below must be exclusive for this path, or two
      // concurrent agents read the same content and the second write erases the
      // first. When the backend cannot offer a lock we still run the same body,
      // but wrapped in optimistic concurrency detection (see `stamp` below).
      const runCycle = (): Promise<ToolResultType<string>> => applyEdits(input, context, filePath);

      return context.env.withFileLock
        ? await context.env.withFileLock(filePath, runCycle)
        : await runCycle();
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
