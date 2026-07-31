// Web Search Tool - Real API integration (Tavily, Brave)

import { z } from 'zod';
import { buildTool, toolResult, toolError } from '../../Tool';
import type { ToolResult as ToolResultType } from '../protocol';
import { KCError } from '../../utils/errors';
import type { PermissionResult } from '../../permissions/protocol';
import { getState } from '../../bootstrap/state';
import { wrapIfUntrustedSource } from '../../utils/toolResultBoundary';

const WebSearchInputSchema = z.object({
  query: z.string().describe('Search query'),
  numResults: z.number().default(10).describe('Number of results to return'),
  includeDomains: z.array(z.string()).optional().describe('Only include results from these domains'),
  excludeDomains: z.array(z.string()).optional().describe('Exclude results from these domains'),
});

type WebSearchInput = z.infer<typeof WebSearchInputSchema>;

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  score?: number;
}

// Rate limiting: max 10 requests per minute
const rateLimiter = {
  timestamps: [] as number[],
  maxPerMinute: 10,
  check(): boolean {
    const now = Date.now();
    this.timestamps = this.timestamps.filter(t => now - t < 60_000);
    if (this.timestamps.length >= this.maxPerMinute) {
      return false;
    }
    this.timestamps.push(now);
    return true;
  },
  resetTime(): number {
    if (this.timestamps.length === 0) return 0;
    const oldest = this.timestamps[0];
    return Math.max(0, 60_000 - (Date.now() - oldest));
  },
};

async function searchTavily(
  query: string,
  apiKey: string,
  numResults: number,
  includeDomains?: string[],
  excludeDomains?: string[]
): Promise<SearchResult[]> {
  const body: Record<string, unknown> = {
    query,
    max_results: numResults,
    include_answer: false,
    include_raw_content: false,
  };
  if (includeDomains && includeDomains.length > 0) {
    body.include_domains = includeDomains;
  }
  if (excludeDomains && excludeDomains.length > 0) {
    body.exclude_domains = excludeDomains;
  }

  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ...body, api_key: apiKey }),
  });

  if (response.status === 429) {
    throw new KCError('api_rate_limit', 'Rate limited by Tavily API. Please wait before searching again.', { provider: 'tavily', status: 429 });
  }
  if (response.status === 401) {
    throw new KCError('api_auth_failed', 'Invalid Tavily API key. Check your searchApiKey configuration.', { provider: 'tavily', status: 401 });
  }
  if (!response.ok) {
    throw new KCError('tool_execution_failed', `Tavily API error: ${response.status} ${response.statusText}`, { provider: 'tavily', status: response.status });
  }

  const data = await response.json() as { results?: Array<{ title: string; url: string; content: string; score: number }> };
  return (data.results || []).map(r => ({
    title: r.title,
    url: r.url,
    snippet: r.content,
    score: r.score,
  }));
}

async function searchBrave(
  query: string,
  apiKey: string,
  numResults: number
): Promise<SearchResult[]> {
  const params = new URLSearchParams({
    q: query,
    count: String(numResults),
  });

  const response = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': apiKey,
    },
  });

  if (response.status === 429) {
    throw new KCError('api_rate_limit', 'Rate limited by Brave Search API. Please wait before searching again.', { provider: 'brave', status: 429 });
  }
  if (response.status === 401 || response.status === 403) {
    throw new KCError('api_auth_failed', 'Invalid Brave Search API key. Check your searchApiKey configuration.', { provider: 'brave', status: response.status });
  }
  if (!response.ok) {
    throw new KCError('tool_execution_failed', `Brave Search API error: ${response.status} ${response.statusText}`, { provider: 'brave', status: response.status });
  }

  const data = await response.json() as { web?: { results?: Array<{ title: string; url: string; description: string }> } };
  return (data.web?.results || []).map(r => ({
    title: r.title,
    url: r.url,
    snippet: r.description,
  }));
}

export const tool = buildTool<WebSearchInput, string>({
  name: 'WebSearch',
  description: 'Search the web for information using Tavily or Brave Search API',

  inputSchema: WebSearchInputSchema,

  call: async (input, context): Promise<ToolResultType<string>> => {
    try {
      // Rate limiting check
      if (!rateLimiter.check()) {
        const waitSec = Math.ceil(rateLimiter.resetTime() / 1000);
        return toolError(`Rate limited. Please wait ${waitSec} seconds before searching again.`);
      }

      // Get search config from state/config, fall back to env for backwards compatibility
      const state = getState();
      const searchProvider = state.config?.searchProvider || process.env.KC_SEARCH_PROVIDER || 'tavily';
      const searchApiKey = state.config?.searchApiKey || process.env.KC_SEARCH_API_KEY;

      if (!searchApiKey) {
        return toolError(
          `Search API key not configured. Set KC_SEARCH_API_KEY environment variable ` +
          `or add searchApiKey to your .kc-cli/settings.json`
        );
      }

      let results: SearchResult[];

      switch (searchProvider) {
        case 'brave':
          results = await searchBrave(input.query, searchApiKey, input.numResults);
          break;
        case 'tavily':
        default:
          results = await searchTavily(
            input.query,
            searchApiKey,
            input.numResults,
            input.includeDomains,
            input.excludeDomains
          );
          break;
      }

      if (results.length === 0) {
        return toolResult('No results found for the query.', {
          metadata: { query: input.query, resultCount: 0, provider: searchProvider },
        });
      }

      const formatted = results
        .map((r, i) => {
          const score = r.score !== undefined ? ` (score: ${r.score.toFixed(2)})` : '';
          return `${i + 1}. **${r.title}**${score}\n   ${r.url}\n   ${r.snippet}`;
        })
        .join('\n\n');

      // S7: web search snippets are untrusted — wrap with an injection boundary.
      return toolResult(wrapIfUntrustedSource(formatted, 'WebSearch') as string, {
        metadata: {
          query: input.query,
          resultCount: results.length,
          provider: searchProvider,
        },
      });
    } catch (error) {
      return toolError(`Web search failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  },

  checkPermissions: (input): PermissionResult => ({
    behavior: 'allow',
    updatedInput: input,
    decisionReason: { type: 'readonly', reason: 'Web search is read-only' },
  }),

  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  prompt: () => 'Search the web for information. Returns title, URL, snippet, and relevance score.',

  getToolUseSummary: (input) => `Searching: "${input.query}"`,
  getActivityDescription: (input) => `Searching web for "${input.query}"`,
});
