// Glob Tool - Find files by pattern matching

import { z } from 'zod';
import { buildTool, toolResult, toolError } from '../../Tool';
import type { ToolResult as ToolResultType } from '../../types/tools';
import type { PermissionResult } from '../../types/permissions';
import * as path from 'path';
import * as fs from 'fs';

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
      const searchPath = path.resolve(context.cwd, input.path);
      const results: string[] = [];

      // Pre-compiled regex for escaping special chars in glob patterns
      const GLOB_ESCAPE_REGEX = /[.+^${}()|[\]\\]/g;

      // Convert glob pattern to regex
      function globToRegex(pattern: string): RegExp {
        const regex = pattern
          .replace(GLOB_ESCAPE_REGEX, '\\$&') // Escape special regex chars (except * and ?)
          .replace(/\*\*/g, '___DOUBLE___')
          .replace(/\*/g, '___SINGLE___')
          .replace(/___DOUBLE___/g, '.*')
          .replace(/___SINGLE___/g, '[^/]*')
          .replace(/\?/g, '[^/]');
        return new RegExp(`^${regex}$`);
      }

      const patternRegex = globToRegex(input.pattern);
      const ignorePatterns = input.ignore.map(globToRegex);

      // Recursively find files
      async function searchDir(dir: string) {
        if (results.length >= input.max_results) return;

        const entries = await fs.promises.readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
          if (results.length >= input.max_results) break;

          const fullPath = path.join(dir, entry.name);
          const relativePath = path.relative(context.cwd, fullPath);

          // Check ignore patterns
          if (ignorePatterns.some(pattern => pattern.test(relativePath))) {
            continue;
          }

          if (entry.isDirectory()) {
            // Skip hidden directories and node_modules
            if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
              await searchDir(fullPath);
            }
          } else if (entry.isFile()) {
            // Check if file matches pattern
            if (patternRegex.test(relativePath)) {
              results.push(relativePath);
            }
          }
        }
      }

      await searchDir(searchPath);

      if (results.length === 0) {
        return toolResult(`No files found matching pattern: ${input.pattern}`);
      }

      // Format results
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
