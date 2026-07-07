// File Read Tool

import { z } from 'zod';
import { buildTool, toolResult, toolError } from '../../Tool';
import type { ToolResult as ToolResultType } from '../protocol';
import type { PermissionResult } from '../../permissions/protocol';
import * as path from 'path';
import * as fs from 'fs';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import { assertPathWithinWorkspace } from '../../utils/path';
import { wrapIfUntrustedSource } from '../../utils/toolResultBoundary';

const FileReadInputSchema = z.object({
  path: z.string().describe('File path to read'),
  range: z.object({
    start: z.number().optional(),
    end: z.number().optional(),
  }).optional().describe('Line range to read'),
  maxSize: z.number().default(100000).describe('Max bytes to read'),
});

type FileReadInput = z.infer<typeof FileReadInputSchema>;

/** Lines of head/tail preview for oversized files */
const PREVIEW_LINES = 50;

/**
 * Stream the first `count` lines from a file.
 */
async function readHeadLines(filePath: string, count: number): Promise<string> {
  const stream = createReadStream(filePath, { encoding: 'utf-8', highWaterMark: 64 * 1024 });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  const lines: string[] = [];
  for await (const line of rl) {
    lines.push(line);
    if (lines.length >= count) break;
  }
  rl.close();
  stream.destroy();
  return lines.join('\n');
}

/**
 * Stream the last `count` lines from a file using a ring buffer.
 */
async function readTailLines(filePath: string, count: number): Promise<string> {
  const stream = createReadStream(filePath, { encoding: 'utf-8', highWaterMark: 64 * 1024 });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  const buffer: string[] = [];
  for await (const line of rl) {
    buffer.push(line);
    if (buffer.length > count) buffer.shift();
  }
  rl.close();
  stream.destroy();
  return buffer.join('\n');
}

/**
 * Read a large file as a stream, returning a head+tail preview.
 * Never loads the entire file into memory.
 */
async function readLargeFilePreview(filePath: string, size: number, maxSize: number): Promise<string> {
  const [head, tail] = await Promise.all([
    readHeadLines(filePath, PREVIEW_LINES),
    readTailLines(filePath, PREVIEW_LINES),
  ]);

  const sizeKB = (size / 1024).toFixed(1);
  const maxKB = (maxSize / 1024).toFixed(1);

  return [
    `[File is ${sizeKB} KB (limit: ${maxKB} KB). Showing first and last ${PREVIEW_LINES} lines.]`,
    '',
    `--- First ${PREVIEW_LINES} lines ---`,
    head,
    '',
    '...',
    '',
    `--- Last ${PREVIEW_LINES} lines ---`,
    tail,
  ].join('\n');
}

export const tool = buildTool<FileReadInput, string>({
  name: 'FileRead',
  description: 'Read file contents. For large files, shows head+tail preview.',

  inputSchema: FileReadInputSchema,

  call: async (input, context): Promise<ToolResultType<string>> => {
    try {
      const filePath = path.resolve(context.cwd, input.path);
      assertPathWithinWorkspace(input.path, context.cwd);

      // Check file exists - prefer ExecutionEnv abstraction when available
      if (context.env) {
        if (!(await context.env.fs.exists(filePath))) {
          return toolError(`File not found: ${filePath}`);
        }
      } else {
        try {
          await fs.promises.access(filePath);
        } catch {
          return toolError(`File not found: ${filePath}`);
        }
      }

      // Check file size
      const fileStat = context.env
        ? await context.env.fs.stat(filePath)
        : await fs.promises.stat(filePath);

      // For files exceeding maxSize, stream a head+tail preview
      // Note: preview uses streaming which is hard to abstract, fall back to direct fs
      if (fileStat.size > input.maxSize) {
        const preview = await readLargeFilePreview(filePath, fileStat.size, input.maxSize);
        // S7: file content is untrusted — wrap with an injection boundary.
        return toolResult(
          wrapIfUntrustedSource(preview, 'FileRead') as string,
          {
            metadata: {
              path: filePath,
              size: fileStat.size,
              lines: PREVIEW_LINES * 2,
              previewOnly: true,
            },
          }
        );
      }

      // Read file
      let content = context.env
        ? await context.env.fs.readFile(filePath, 'utf-8')
        : await fs.promises.readFile(filePath, 'utf-8');
      let lineCount: number;

      // Apply range if specified
      if (input.range) {
        const lines = content.split('\n');
        const start = input.range.start ?? 0;
        const end = input.range.end ?? lines.length;
        content = lines.slice(start, end).join('\n');
        lineCount = end - start;
      } else {
        // Count lines without a second split by counting newlines
        lineCount = 1;
        for (let i = 0; i < content.length; i++) {
          if (content.charCodeAt(i) === 10) lineCount++;
        }
      }

      return toolResult(
        // S7: file content is untrusted — wrap with an injection boundary.
        wrapIfUntrustedSource(content, 'FileRead') as string,
        {
          metadata: {
            path: filePath,
            size: fileStat.size,
            lines: lineCount,
          },
        }
      );
    } catch (error) {
      return toolError(`Failed to read file: ${error instanceof Error ? error.message : String(error)}`);
    }
  },

  checkPermissions: (input, context): PermissionResult => {
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

  prompt: () => 'Read file contents. Supports line ranges and large file preview via streaming.',

  getToolUseSummary: (input) => `Reading: ${input.path}`,
  getActivityDescription: (input) => `Reading file ${input.path}`,
});

