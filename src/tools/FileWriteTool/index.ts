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

/**
 * The write cycle, extracted so it can run under the per-file lock.
 * (round4 §3-R1 — see the `withFileLock` call in `call`.)
 */
async function writeFileOnce(
  input: FileWriteInput,
  context: import('../protocol').ToolUseContext,
  filePath: string,
): Promise<ToolResultType<string>> {
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
  // T2 (H2): atomic write with a best-effort timestamped backup so a
  // crash mid-write cannot truncate the target and the prior content is
  // recoverable (backupPath feeds T3 undo + UI diff/restore).
  const { backupPath, backupFailed } = await context.env.fs.writeFileAtomic(
    filePath,
    writeContent,
    { cwd: context.cwd },
  );

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
        backupPath,
        backupFailed,
      },
    }
  );
}

export const tool = buildTool<FileWriteInput, string>({
  name: 'FileWrite',
  description: 'Write or create files',

  inputSchema: FileWriteInputSchema,

  call: async (input, context): Promise<ToolResultType<string>> => {
    try {
      const filePath = path.resolve(context.cwd, input.path);
      assertPathWithinWorkspace(input.path, context.cwd);

      // R1: with `append`, the tool reads the existing content and writes it
      // back, so two concurrent writers lose one payload entirely. Serialise
      // the cycle per path; backends without locking fall back to plain
      // execution so behaviour is unchanged there.
      const runCycle = (): Promise<ToolResultType<string>> =>
        writeFileOnce(input, context, filePath);

      return context.env.withFileLock
        ? await context.env.withFileLock(filePath, runCycle)
        : await runCycle();
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
