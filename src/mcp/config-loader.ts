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

  // User global config: ~/.kc-cli/mcp.json
  const userConfigPath = path.join(os.homedir(), '.kc-cli', 'mcp.json');
  const userConfig = await loadConfigFile(userConfigPath);
  if (userConfig) {
    Object.assign(servers, userConfig.mcpServers);
    sources.push(userConfigPath);
  }

  // Project config: .mcp.json in project root
  const projectConfigPath = path.join(projectDir, '.mcp.json');
  const projectConfig = await loadConfigFile(projectConfigPath);
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
