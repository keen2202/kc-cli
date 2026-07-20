// Web Fetch Tool - Fetch content from URLs

import { z } from 'zod';
import { buildTool, toolResult, toolError } from '../../Tool';
import type { ToolResult as ToolResultType } from '../protocol';
import type { PermissionResult } from '../../permissions/protocol';
import { secondsToMs } from '../../utils/timeout';
import { isInternalUrl } from '../../utils/ssrf';
import { wrapIfUntrustedSource } from '../../utils/toolResultBoundary';
import { VERSION } from '../../bootstrap/cli-config';
import * as https from 'https';
import * as http from 'http';

const WebFetchInputSchema = z.object({
  url: z.string().url().describe('URL to fetch'),
  method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD']).default('GET').describe('HTTP method'),
  headers: z.record(z.string()).optional().describe('HTTP headers'),
  body: z.string().optional().describe('Request body (for POST/PUT/PATCH)'),
  max_size: z.number().default(100000).describe('Max response size in bytes'),
  timeout: z.number().default(30).describe('Timeout in seconds'),
});

type WebFetchInput = z.infer<typeof WebFetchInputSchema>;

export const tool = buildTool<WebFetchInput, string>({
  name: 'WebFetch',
  description: 'Fetch content from HTTP URLs',

  inputSchema: WebFetchInputSchema,

  call: async (input, context): Promise<ToolResultType<string>> => {
    try {
      const url = new URL(input.url);
      const isHttps = url.protocol === 'https:';
      const client = isHttps ? https : http;

      // Guard against NaN timeout (NaN * 1000 = NaN, and setTimeout(NaN) never fires)
      const timeoutMs = secondsToMs(input.timeout, 30_000);

      const options: http.RequestOptions = {
        method: input.method,
        headers: {
          'User-Agent': `kc-cli/${VERSION}`,
          ...input.headers,
        },
        timeout: timeoutMs,
      };

      return new Promise((resolve) => {
        let req: http.ClientRequest | undefined;

        // Global timeout: ensure the entire Promise resolves even if
        // the socket timeout or response stream hangs indefinitely.
        const globalTimeout = setTimeout(() => {
          if (req) req.destroy();
          resolve(toolError(`Request timed out after ${timeoutMs / 1000}s (global)`));
        }, timeoutMs + 5000);

        // client.request() throws synchronously for unsupported protocols (e.g. file:).
        try {
          req = client.request(url, options, (res) => {
            // Handle redirects
            if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
              clearTimeout(globalTimeout);
              // S6: validate every redirect hop against the same SSRF guard as
              // the initial URL. A redirect to an internal/private range is rejected.
              let redirectUrl: URL;
              try {
                redirectUrl = new URL(res.headers.location, url);
              } catch {
                resolve(toolError(`Invalid redirect Location: ${res.headers.location}`));
                return;
              }
              if (isInternalUrl(redirectUrl)) {
                resolve(toolError(
                  `SSRF blocked: redirect to internal network ${redirectUrl.hostname} is not allowed`
                ));
                return;
              }
              resolve(toolResult(`Redirect to: ${res.headers.location}`, {
                metadata: { status_code: res.statusCode, redirect: res.headers.location },
              }));
              return;
            }

            let data = '';
            let size = 0;

            res.on('data', (chunk) => {
              size += chunk.length;
              if (size > input.max_size) {
                clearTimeout(globalTimeout);
                res.destroy();
                resolve(toolError(`Response too large (max ${input.max_size} bytes)`));
                return;
              }
              data += chunk.toString();
            });

            res.on('end', () => {
              clearTimeout(globalTimeout);
              // S7: web content is untrusted — wrap with an injection boundary.
              const body = wrapIfUntrustedSource(
                `HTTP ${res.statusCode}\n\n${data.slice(0, input.max_size)}`,
                'WebFetch'
              ) as string;
              resolve(toolResult(
                body,
                {
                  metadata: {
                    status_code: res.statusCode,
                    content_type: res.headers['content-type'],
                    content_length: data.length,
                  },
                }
              ));
            });
          });

          req.on('error', (error) => {
            clearTimeout(globalTimeout);
            resolve(toolError(`HTTP request failed: ${error.message}`));
          });

          req.on('timeout', () => {
            clearTimeout(globalTimeout);
            req?.destroy();
            resolve(toolError(`Request timed out after ${timeoutMs / 1000}s`));
          });

          // Write body if present
          if (input.body) {
            req.write(input.body);
          }

          req.end();
        } catch (error) {
          clearTimeout(globalTimeout);
          resolve(toolError(`HTTP request failed: ${error instanceof Error ? error.message : String(error)}`));
        }
      });
    } catch (error) {
      return toolError(`WebFetch failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  },

  checkPermissions: (input, context): PermissionResult => {
    // Block internal/private URLs (SSRF) — same guard applied to redirect hops in call().
    const url = new URL(input.url);
    if (isInternalUrl(url)) {
      return {
        behavior: 'deny',
        message: `Access to internal URLs is blocked: ${url.hostname}`,
      };
    }

    return {
      behavior: 'ask',
      message: `Fetch URL: ${input.url}`,
    };
  },

  isReadOnly: (input) => input.method === 'GET' || input.method === 'HEAD',
  isConcurrencySafe: () => true,

  prompt: () => 'Fetch HTTP content. Supports all HTTP methods.',

  getToolUseSummary: (input) => `${input.method} ${input.url}`,
  getActivityDescription: (input) => `Fetching ${input.url}`,
});
