// Runtime schema for `.mcp.json` / `~/.kc-cli/mcp.json` — round4 §2-S6
//
// The loader previously cast the parsed JSON with `as MCPConfig`. Any shape
// was therefore accepted: `{"mcpServers": {"x": {"type": "stdio"}}}` with no
// `command` reached `spawn(command, args)` with `command === undefined`, and
// `{"mcpServers": {"x": {"command": 123}}}` produced a confusing TypeError
// deep inside child_process instead of a diagnosable config error.
//
// Because `.mcp.json` lives in a project directory, it is untrusted input: any
// repository a user clones can declare a server that is executed on startup.

import { z } from 'zod';

export const MCPServerConfigSchema = z
  .object({
    type: z.enum(['stdio', 'http']),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    url: z.string().url().optional(),
    env: z.record(z.string()).optional(),
    headers: z.record(z.string()).optional(),
    enabled: z.boolean().optional(),
    oauth: z
      .object({
        clientId: z.string().optional(),
        clientSecret: z.string().optional(),
        tokenUrl: z.string().optional(),
        scopes: z.array(z.string()).optional(),
      })
      .optional(),
  })
  // Transport-specific requirements: stdio needs a command to spawn, http a
  // URL to connect to. Without these, the failure surfaces far from its cause.
  .refine((cfg) => cfg.type !== 'stdio' || typeof cfg.command === 'string', {
    message: 'stdio servers require a "command" string',
  })
  .refine((cfg) => cfg.type !== 'http' || typeof cfg.url === 'string', {
    message: 'http servers require a "url" string',
  });

export const MCPConfigSchema = z.object({
  mcpServers: z.record(MCPServerConfigSchema),
});

export type ValidatedMCPServerConfig = z.infer<typeof MCPServerConfigSchema>;
export type ValidatedMCPConfig = z.infer<typeof MCPConfigSchema>;
