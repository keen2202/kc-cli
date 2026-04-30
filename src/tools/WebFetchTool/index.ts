// Web Fetch Tool - Fetch content from URLs

import { z } from 'zod';
import { buildTool, toolResult, toolError } from '../../Tool';
import type { ToolResult as ToolResultType } from '../../types/tools';
import type { PermissionResult } from '../../types/permissions';
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

      const options: http.RequestOptions = {
        method: input.method,
        headers: {
          'User-Agent': 'kc-cli/0.1.0',
          ...input.headers,
        },
        timeout: input.timeout * 1000,
      };

      return new Promise((resolve) => {
        const req = client.request(url, options, (res) => {
          // Handle redirects
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
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
              res.destroy();
              resolve(toolError(`Response too large (max ${input.max_size} bytes)`));
              return;
            }
            data += chunk.toString();
          });

          res.on('end', () => {
            resolve(toolResult(
              `HTTP ${res.statusCode}\n\n${data.slice(0, input.max_size)}`,
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
          resolve(toolError(`HTTP request failed: ${error.message}`));
        });

        req.on('timeout', () => {
          req.destroy();
          resolve(toolError(`Request timed out after ${input.timeout}s`));
        });

        // Write body if present
        if (input.body) {
          req.write(input.body);
        }

        req.end();
      });
    } catch (error) {
      return toolError(`WebFetch failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  },

  checkPermissions: (input, context): PermissionResult => {
    // Block internal/private URLs (RFC 1918 private ranges)
    const url = new URL(input.url);
    const hostname = url.hostname.toLowerCase();

    // Parse IP address for range checks
    const ipMatch = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);

    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname.startsWith('192.168.') ||
      hostname.startsWith('10.') ||
      (ipMatch && (() => {
        // Check 172.16.0.0/12 range (172.16.0.0 - 172.31.255.255)
        const octet1 = parseInt(ipMatch[1], 10);
        const octet2 = parseInt(ipMatch[2], 10);
        return octet1 === 172 && octet2 >= 16 && octet2 <= 31;
      })())
    ) {
      return {
        behavior: 'deny',
        message: `Access to internal URLs is blocked: ${hostname}`,
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
