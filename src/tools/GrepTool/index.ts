// Grep Tool - Search file contents with regex patterns

import { z } from 'zod';
import { buildTool, toolResult, toolError } from '../../Tool';
import type { ToolResult as ToolResultType } from '../protocol';
import type { PermissionResult } from '../../permissions/protocol';
import * as path from 'path';
import * as fs from 'fs';
import { assertPathWithinWorkspace } from '../../utils/path';
import { walkDirectory } from '../../utils/fs-walk';

const GrepInputSchema = z.object({
  pattern: z.string().describe('Regex pattern to search for'),
  path: z.string().default('.').describe('Directory or file to search'),
  case_sensitive: z.boolean().default(false).describe('Case sensitive search'),
  max_results: z.number().default(100).describe('Maximum number of results'),
  file_pattern: z.string().optional().describe('Glob pattern to filter files (e.g., "*.ts")'),
  context_lines: z.number().default(0).describe('Number of context lines around match'),
});

type GrepInput = z.infer<typeof GrepInputSchema>;

export const tool = buildTool<GrepInput, string>({
  name: 'Grep',
  description: 'Search file contents with regex patterns',

  inputSchema: GrepInputSchema,

  call: async (input, context): Promise<ToolResultType<string>> => {
    try {
      assertPathWithinWorkspace(input.path, context.cwd);

      const searchPath = path.resolve(context.cwd, input.path);
      const flags = input.case_sensitive ? 'g' : 'gi';
      let regex: RegExp;
      try {
        regex = new RegExp(input.pattern, flags);
      } catch (regexError) {
        return toolError(`Invalid regex pattern: ${input.pattern} - ${regexError instanceof Error ? regexError.message : String(regexError)}`);
      }
      const results: Array<{ file: string; line: number; match: string; context?: string }> = [];

      // Pre-compile glob pattern once (not per-file in recursion)
      let globRegex: RegExp | null = null;
      if (input.file_pattern) {
        globRegex = new RegExp(input.file_pattern.replace(/\*/g, '.*').replace(/\?/g, '.'));
      }

      await walkDirectory(searchPath, {
        maxResults: input.max_results,
        baseDir: context.cwd,
        onFile: async (entry) => {
          if (results.length >= input.max_results) return false;
          if (globRegex && !globRegex.test(entry.name)) return;

          try {
            const content = await fs.promises.readFile(entry.fullPath, 'utf-8');
            const lines = content.split('\n');

            for (let i = 0; i < lines.length; i++) {
              if (regex.test(lines[i])) {
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

                results.push({
                  file: entry.relativePath,
                  line: i + 1,
                  match: matchLine,
                  context: contextLines,
                });

                if (results.length >= input.max_results) break;
              }
            }
          } catch {
            // Skip files that can't be read
          }
        },
      });

      if (results.length === 0) {
        return toolResult(`No matches found for pattern: ${input.pattern}`);
      }

      const formatted = results.map(r => {
        if (r.context) {
          return `${r.file}:${r.line}\n${r.context}`;
        }
        return `${r.file}:${r.line}: ${r.match}`;
      }).join('\n\n');

      return toolResult(
        `Found ${results.length} match(es) for "${input.pattern}":\n\n${formatted}`,
        {
          metadata: {
            pattern: input.pattern,
            matches: results.length,
            search_path: input.path,
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

  prompt: () => 'Search file contents with regex. Supports context lines.',

  getToolUseSummary: (input) => `Searching: "${input.pattern}" in ${input.path}`,
  getActivityDescription: (input) => `Grepping for "${input.pattern}"`,
});
