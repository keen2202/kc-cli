// Web Search Tool

import { z } from 'zod';
import { buildTool, toolResult, toolError } from '../../Tool';
import type { ToolResult as ToolResultType } from '../../types/tools';
import type { PermissionResult } from '../../types/permissions';

const WebSearchInputSchema = z.object({
  query: z.string().describe('Search query'),
  numResults: z.number().default(10).describe('Number of results'),
});

type WebSearchInput = z.infer<typeof WebSearchInputSchema>;

export const tool = buildTool<WebSearchInput, string>({
  name: 'WebSearch',
  description: 'Search the web for information',

  inputSchema: WebSearchInputSchema,

  call: async (input, context): Promise<ToolResultType<string>> => {
    try {
      // Placeholder - would integrate with search API (Tavily, Google, etc.)
      const results = [
        {
          title: `Result 1 for: ${input.query}`,
          url: 'https://example.com/1',
          snippet: 'This is a sample search result snippet...',
        },
        {
          title: `Result 2 for: ${input.query}`,
          url: 'https://example.com/2',
          snippet: 'Another sample search result...',
        },
      ];

      const formatted = results
        .map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}`)
        .join('\n\n');

      return toolResult(formatted, {
        metadata: { query: input.query, resultCount: results.length },
      });
    } catch (error) {
      return toolError(`Web search failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  },

  checkPermissions: (): PermissionResult => ({
    behavior: 'allow',
    updatedInput: {},
    decisionReason: { type: 'readonly', reason: 'Web search is read-only' },
  }),

  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  prompt: () => 'Search the web for information. Returns title, URL, and snippet.',

  getToolUseSummary: (input) => `Searching: "${input.query}"`,
  getActivityDescription: (input) => `Searching web for "${input.query}"`,
});
