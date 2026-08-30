// MCP configuration loader
// Loads .mcp.json from project root and ~/.kc-cli/mcp.json for user global
//
// Both files describe processes this CLI will spawn. The project-scoped one is
// untrusted input (it ships with the repository), so every entry is
// schema-validated before it can reach a spawn call — round4 §2-S6.

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { MCPConfig, MCPServerConfig } from './types';
import { MCPServerConfigSchema } from './schema';
import { logger } from '../services/logger';

export type MCPServerOrigin = 'user' | 'project';

export interface LoadedMCPConfig {
  servers: Record<string, MCPServerConfig>;
  sources: string[];
  /** Which file each server came from — drives the project-scoped trust gate. */
  origins: Record<string, MCPServerOrigin>;
  /** Entries dropped by schema validation, with the reason. */
  rejected: Array<{ name: string; source: string; reason: string }>;
}

interface LoadedFile {
  servers: Record<string, MCPServerConfig>;
  rejected: LoadedMCPConfig['rejected'];
}

export async function loadMCPConfig(projectDir: string): Promise<LoadedMCPConfig> {
  const servers: Record<string, MCPServerConfig> = {};
  const sources: string[] = [];
  const origins: Record<string, MCPServerOrigin> = {};
  const rejected: LoadedMCPConfig['rejected'] = [];

  // Load both configs in parallel (independent reads)
  const userConfigPath = path.join(os.homedir(), '.kc-cli', 'mcp.json');
  const projectConfigPath = path.join(projectDir, '.mcp.json');
  const [userConfig, projectConfig] = await Promise.all([
    loadConfigFile(userConfigPath),
    loadConfigFile(projectConfigPath),
  ]);

  if (userConfig) {
    Object.assign(servers, userConfig.servers);
    for (const name of Object.keys(userConfig.servers)) origins[name] = 'user';
    rejected.push(...userConfig.rejected);
    sources.push(userConfigPath);
  }

  if (projectConfig) {
    // Project config overrides user config for same server names
    Object.assign(servers, projectConfig.servers);
    for (const name of Object.keys(projectConfig.servers)) origins[name] = 'project';
    rejected.push(...projectConfig.rejected);
    sources.push(projectConfigPath);
  }

  // Filter out disabled servers
  for (const [name, config] of Object.entries(servers)) {
    if (config.enabled === false) {
      delete servers[name];
      delete origins[name];
    }
  }

  return { servers, sources, origins, rejected };
}

/**
 * Read and validate one config file.
 *
 * Validation is per-server so a single malformed entry does not silently take
 * down every other server in the same file; each rejection is logged with the
 * server name and the exact reason.
 */
async function loadConfigFile(filePath: string): Promise<LoadedFile | null> {
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = await fs.promises.readFile(filePath, 'utf-8');
    const parsed: unknown = JSON.parse(content);

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const rawServers = (parsed as { mcpServers?: unknown }).mcpServers;
    if (rawServers === null || typeof rawServers !== 'object' || Array.isArray(rawServers)) {
      return null;
    }

    const servers: Record<string, MCPServerConfig> = {};
    const rejected: LoadedMCPConfig['rejected'] = [];

    for (const [name, candidate] of Object.entries(rawServers as Record<string, unknown>)) {
      const result = MCPServerConfigSchema.safeParse(candidate);
      if (result.success) {
        servers[name] = result.data as MCPServerConfig;
        continue;
      }
      const reason = result.error.issues
        .map((i) => (i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message))
        .join('; ');
      rejected.push({ name, source: filePath, reason });
      logger.mcp.warn('[MCP config] rejected invalid server definition — skipped', {
        source: filePath,
        server: name,
        reason,
      });
    }

    return { servers, rejected };
  } catch (err) {
    logger.mcp.warn('[MCP config] unreadable config file', {
      source: filePath,
      reason: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
