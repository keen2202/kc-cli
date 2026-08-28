// Grep Tool - Search file contents with regex patterns
//
// One traversal serves N patterns (OR-matched), and output modes let the
// agent locate files cheaply (files_with_matches/count) before spending a
// read on the interesting ones — this is the main lever against multi-call
// search storms (docs/specs/tool-search-efficiency-spec.md).

import { z } from 'zod';
import { buildTool, toolResult, toolError } from '../../Tool';
import type { ToolResult as ToolResultType } from '../protocol';
import type { PermissionResult } from '../../permissions/protocol';
import * as path from 'path';
import * as fs from 'fs';
import { assertPathWithinWorkspace } from '../../utils/path';
import { walkDirectory } from '../../utils/fs-walk';

const GrepInputSchema = z.object({
  // describe() before optional()/default() so the description survives the
  // tool-schema JSON conversion providers see.
  pattern: z.string().describe('Regex pattern to search for (single-pattern form)').optional(),
  patterns: z.array(z.string()).describe('Multiple regex patterns, OR-matched in ONE traversal — prefer this over several sequential Grep calls').optional(),
  path: z.string().default('.').describe('Directory or file to search'),
  case_sensitive: z.boolean().default(false).describe('Case sensitive search'),
  max_results: z.number().default(100).describe('Maximum number of results (matches in content mode, files otherwise)'),
  file_pattern: z.string().optional().describe('Glob pattern to filter files (e.g., "*.ts")'),
  context_lines: z.number().default(0).describe('Number of context lines around match (content mode only)'),
  output_mode: z.enum(['content', 'files_with_matches', 'count']).default('content')
    .describe('content = matching lines; files_with_matches = file paths only; count = per-file match counts'),
}).refine(
  (d) => d.pattern !== undefined || (d.patterns !== undefined && d.patterns.length > 0),
  { message: 'Provide either "pattern" or a non-empty "patterns" array' },
);

type GrepInput = z.infer<typeof GrepInputSchema>;

/** Files larger than this are skipped (content scan cost, not read precision). */
const MAX_FILE_BYTES = 1_000_000;
/** Bytes inspected for the null-byte binary sniff. */
const BINARY_SNIFF_BYTES = 8192;

export const tool = buildTool<GrepInput, string>({
  name: 'Grep',
  description: 'Search file contents with one or more regex patterns (single traversal). Output modes: matching lines, matching file paths, or per-file counts.',

  inputSchema: GrepInputSchema,

  call: async (input, context): Promise<ToolResultType<string>> => {
    try {
      assertPathWithinWorkspace(input.path, context.cwd);

      const searchPath = path.resolve(context.cwd, input.path);
      const patterns = input.patterns && input.patterns.length > 0
        ? input.patterns
        : [input.pattern as string];
      // Runtime default: direct callers that bypass schema parsing (tests,
      // programmatic use) may omit output_mode.
      const mode = input.output_mode ?? 'content';
      const flags = input.case_sensitive ? 'g' : 'gi';

      let regexes: RegExp[];
      try {
        regexes = patterns.map((p) => new RegExp(p, flags));
      } catch (regexError) {
        return toolError(`Invalid regex pattern: ${regexError instanceof Error ? regexError.message : String(regexError)}`);
      }

      const contentMatches: Array<{ file: string; line: number; match: string; context?: string }> = [];
      // file -> match count (files_with_matches / count modes)
      const fileCounts = new Map<string, number>();

      // Pre-compile glob pattern once (not per-file in recursion)
      let globRegex: RegExp | null = null;
      if (input.file_pattern) {
        globRegex = new RegExp(input.file_pattern.replace(/\*/g, '.*').replace(/\?/g, '.'));
      }

      await walkDirectory(searchPath, {
        maxResults: input.max_results,
        baseDir: context.cwd,
        onFile: async (entry) => {
          if (mode === 'content' && contentMatches.length >= input.max_results) return false;
          if (mode !== 'content' && fileCounts.size >= input.max_results) return false;
          if (globRegex && !globRegex.test(entry.name)) return;

          try {
            // Binary sniff + size cap: read the first chunk before committing
            // to a full decode so minified maps / images / lockfiles don't
            // flood the traversal.
            const handle = await fs.promises.open(entry.fullPath, 'r');
            try {
              const stat = await handle.stat();
              if (stat.size > MAX_FILE_BYTES) return;
              const sniff = Buffer.alloc(Math.min(BINARY_SNIFF_BYTES, stat.size));
              if (sniff.length > 0) {
                const { bytesRead } = await handle.read(sniff, 0, sniff.length, 0);
                if (sniff.slice(0, bytesRead).includes(0)) return; // binary
              }
              const content = await handle.readFile('utf-8');
              const lines = content.split('\n');

              if (mode === 'content') {
                for (let i = 0; i < lines.length; i++) {
                  if (!regexes.some((re) => re.test(lines[i]))) continue;
                  const matchLine = lines[i].trim();

                  let contextLines: string | undefined;
                  if (input.context_lines > 0) {
                    const start = Math.max(0, i - input.context_lines);
                    const end = Math.min(lines.length, i + input.context_lines + 1);
                    contextLines = lines.slice(start, end).map((l, idx) => {
                      const lineNum = start + idx + 1;
                      return lineNum === i + 1 ? `> ${lineNum}: ${l}` : `  ${lineNum}: ${l}`;
                    }).join('\n');
                  }

                  contentMatches.push({
                    file: entry.relativePath,
                    line: i + 1,
                    match: matchLine,
                    context: contextLines,
                  });

                  if (contentMatches.length >= input.max_results) break;
                }
              } else {
                let count = 0;
                for (const line of lines) {
                  if (regexes.some((re) => re.test(line))) count++;
                }
                if (count > 0) fileCounts.set(entry.relativePath, count);
              }
            } finally {
              await handle.close();
            }
          } catch {
            // Skip files that can't be read
          }
        },
      });

      if (mode === 'content') {
        if (contentMatches.length === 0) {
          return toolResult(`No matches found for pattern: ${patterns.join(' | ')}`);
        }

        const formatted = contentMatches.map(r => {
          if (r.context) {
            return `${r.file}:${r.line}\n${r.context}`;
          }
          return `${r.file}:${r.line}: ${r.match}`;
        }).join('\n\n');

        return toolResult(
          `Found ${contentMatches.length} match(es) for "${patterns.join(' | ')}":\n\n${formatted}`,
          {
            metadata: {
              pattern: patterns.join(' | '),
              matches: contentMatches.length,
              search_path: input.path,
              output_mode: mode,
            },
          }
        );
      }

      // files_with_matches / count modes
      const files = [...fileCounts.entries()];
      if (files.length === 0) {
        return toolResult(`No files matching pattern: ${patterns.join(' | ')}`);
      }

      const body = mode === 'count'
        ? files.map(([file, count]) => `${file}: ${count}`).join('\n')
        : files.map(([file]) => file).join('\n');

      return toolResult(
        `${mode === 'count' ? 'Match counts' : 'Matching files'} (${files.length} file(s)) for "${patterns.join(' | ')}":\n\n${body}`,
        {
          metadata: {
            pattern: patterns.join(' | '),
            files: files.length,
            total_matches: files.reduce((sum, [, c]) => sum + c, 0),
            search_path: input.path,
            output_mode: mode,
          },
        }
      );
    } catch (error) {
      return toolError(`Grep failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  },

  checkPermissions: (): PermissionResult => ({
    behavior: 'allow',
    updatedInput: {},
    decisionReason: { type: 'readonly', reason: 'File search is read-only' },
  }),

  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  prompt: () =>
    'Search file contents with one or more regex patterns in a single traversal. ' +
    'Pass multiple queries as "patterns" instead of making several Grep calls. ' +
    'Strategy: use output_mode "files_with_matches" first to locate candidates cheaply, ' +
    'then FileRead the interesting ones; use "count" to gauge spread. ' +
    'When several independent searches are needed, issue them as parallel tool calls in one message.',

  getToolUseSummary: (input) => `Searching: "${(input.patterns && input.patterns.length > 0 ? input.patterns.join(' | ') : input.pattern) ?? ''}" in ${input.path}`,
  getActivityDescription: (input) => `Grepping for "${(input.patterns && input.patterns.length > 0 ? input.patterns.join(' | ') : input.pattern) ?? ''}"`,
});
