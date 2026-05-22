// MCP configuration loader
// Loads .mcp.json from project root and ~/.kc-cli/mcp.json for user global

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { MCPConfig, MCPServerConfig } from './types';

export interface LoadedMCPConfig {
  servers: Record<string, MCPServerConfig>;
  sources: string[];
}

export async function loadMCPConfig(projectDir: string): Promise<LoadedMCPConfig> {
  const servers: Record<string, MCPServerConfig> = {};
  const sources: string[] = [];

  // Load both configs in parallel (independent reads)
  const userConfigPath = path.join(os.homedir(), '.kc-cli', 'mcp.json');
  const projectConfigPath = path.join(projectDir, '.mcp.json');
  const [userConfig, projectConfig] = await Promise.all([
    loadConfigFile(userConfigPath),
    loadConfigFile(projectConfigPath),
  ]);

  if (userConfig) {
    Object.assign(servers, userConfig.mcpServers);
    sources.push(userConfigPath);
  }

  if (projectConfig) {
    // Project config overrides user config for same server names
    Object.assign(servers, projectConfig.mcpServers);
    sources.push(projectConfigPath);
  }

  // Filter out disabled servers
  for (const [name, config] of Object.entries(servers)) {
    if (config.enabled === false) {
      delete servers[name];
    }
  }

  return { servers, sources };
}

async function loadConfigFile(filePath: string): Promise<MCPConfig | null> {
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = await fs.promises.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(content);

    if (!parsed.mcpServers || typeof parsed.mcpServers !== 'object') {
      return null;
    }

    return parsed as MCPConfig;
  } catch {
    return null;
  }
}
