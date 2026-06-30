// Glob Tool - Find files by pattern matching

import { z } from 'zod';
import { buildTool, toolResult, toolError } from '../../Tool';
import type { ToolResult as ToolResultType } from '../protocol';
import type { PermissionResult } from '../../permissions/protocol';
import * as path from 'path';
import { assertPathWithinWorkspace } from '../../utils/path';
import { walkDirectory } from '../../utils/fs-walk';

const GlobInputSchema = z.object({
  pattern: z.string().describe('Glob pattern (e.g., "**/*.ts", "src/**/*.tsx")'),
  path: z.string().default('.').describe('Root directory to search'),
  ignore: z.array(z.string()).default([]).describe('Patterns to ignore'),
  max_results: z.number().default(1000).describe('Maximum number of results'),
});

type GlobInput = z.infer<typeof GlobInputSchema>;

export const tool = buildTool<GlobInput, string>({
  name: 'Glob',
  description: 'Find files by glob pattern matching',

  inputSchema: GlobInputSchema,

  call: async (input, context): Promise<ToolResultType<string>> => {
    try {
      assertPathWithinWorkspace(input.path, context.cwd);

      const searchPath = path.resolve(context.cwd, input.path);
      const results: string[] = [];

      // Pre-compiled regex for escaping special chars in glob patterns
      const GLOB_ESCAPE_REGEX = /[.+^${}()|[\]\\]/g;

      // Convert glob pattern to regex
      function globToRegex(pattern: string): RegExp {
        const regex = pattern
          .replace(GLOB_ESCAPE_REGEX, '\\$&')
          .replace(/\*\*/g, '___DOUBLE___')
          .replace(/\*/g, '___SINGLE___')
          .replace(/___DOUBLE___/g, '.*')
          .replace(/___SINGLE___/g, '[^/]*')
          .replace(/\?/g, '[^/]');
        return new RegExp(`^${regex}$`);
      }

      const patternRegex = globToRegex(input.pattern);
      const ignorePatterns = input.ignore.map(globToRegex);

      await walkDirectory(searchPath, {
        maxResults: input.max_results,
        baseDir: context.cwd,
        onFile: async (entry) => {
          if (ignorePatterns.some(p => p.test(entry.relativePath))) return;
          if (patternRegex.test(entry.relativePath)) {
            results.push(entry.relativePath);
          }
        },
      });

      if (results.length === 0) {
        return toolResult(`No files found matching pattern: ${input.pattern}`);
      }

      const formatted = results.join('\n');

      return toolResult(
        `Found ${results.length} file(s) matching "${input.pattern}":\n\n${formatted}`,
        {
          metadata: {
            pattern: input.pattern,
            files_found: results.length,
            search_path: input.path,
          },
        }
      );
    } catch (error) {
      return toolError(`Glob failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  },

  checkPermissions: (): PermissionResult => ({
    behavior: 'allow',
    updatedInput: {},
    decisionReason: { type: 'readonly', reason: 'File pattern matching is read-only' },
  }),

  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  prompt: () => 'Find files by glob pattern. Supports ** for recursive matching.',

  getToolUseSummary: (input) => `Finding: ${input.pattern}`,
  getActivityDescription: (input) => `Globbing for ${input.pattern}`,
});
