// Language server registry
// Centralizes language server configurations and supports auto-discovery.

import { execSync } from 'child_process';

export type LSPCapability = 'completion' | 'hover' | 'definition' | 'references' | 'rename' | 'codeAction' | 'diagnostics';

export interface LanguageServerConfig {
  languageId: string;
  extensions: string[];
  command: string;
  args: string[];
  capabilities: LSPCapability[];
  /** Optional initialization options sent to the language server */
  initializationOptions?: Record<string, unknown>;
}

/**
 * Built-in language server registry.
 * Each entry defines how to connect to a language server for a specific language.
 */
export const LANGUAGE_REGISTRY: LanguageServerConfig[] = [
  {
    languageId: 'typescript',
    extensions: ['.ts', '.tsx', '.js', '.jsx'],
    command: 'typescript-language-server',
    args: ['--stdio'],
    capabilities: ['completion', 'hover', 'definition', 'references', 'rename', 'codeAction', 'diagnostics'],
  },
  {
    languageId: 'go',
    extensions: ['.go'],
    command: 'gopls',
    args: [],
    capabilities: ['completion', 'hover', 'definition', 'references', 'rename', 'codeAction', 'diagnostics'],
  },
  {
    languageId: 'python',
    extensions: ['.py'],
    command: 'pylsp',
    args: [],
    capabilities: ['completion', 'hover', 'definition', 'references', 'codeAction', 'diagnostics'],
  },
  {
    languageId: 'rust',
    extensions: ['.rs'],
    command: 'rust-analyzer',
    args: [],
    capabilities: ['completion', 'hover', 'definition', 'references', 'rename', 'codeAction', 'diagnostics'],
  },
  {
    languageId: 'java',
    extensions: ['.java'],
    command: 'jdtls',
    args: [],
    capabilities: ['completion', 'hover', 'definition', 'references', 'rename', 'codeAction', 'diagnostics'],
  },
  {
    languageId: 'cpp',
    extensions: ['.c', '.cpp', '.cc', '.h', '.hpp'],
    command: 'clangd',
    args: [],
    capabilities: ['completion', 'hover', 'definition', 'references', 'rename', 'codeAction', 'diagnostics'],
  },
  {
    languageId: 'ruby',
    extensions: ['.rb'],
    command: 'solargraph',
    args: ['stdio'],
    capabilities: ['completion', 'hover', 'definition', 'references', 'diagnostics'],
  },
];

// Pre-built extension → languageId map for O(1) lookups (avoids iterating registry per call)
const extensionToLanguage = new Map<string, string>();
for (const config of LANGUAGE_REGISTRY) {
  for (const ext of config.extensions) {
    extensionToLanguage.set(ext.toLowerCase(), config.languageId);
  }
}

/**
 * Map file extension to language ID using the registry (O(1) Map lookup).
 */
export function detectLanguageFromRegistry(filePath: string): string | null {
  const ext = getExtension(filePath).toLowerCase();
  return extensionToLanguage.get(ext) ?? null;
}

// Pre-built languageId → config map for O(1) lookups
const languageConfigMap = new Map<string, LanguageServerConfig>();
for (const config of LANGUAGE_REGISTRY) {
  languageConfigMap.set(config.languageId, config);
}

/**
 * Get the language server config for a given language ID (O(1) Map lookup).
 */
export function getLanguageConfig(languageId: string): LanguageServerConfig | null {
  return languageConfigMap.get(languageId) ?? null;
}

/**
 * Get all registered language IDs.
 */
export function listRegisteredLanguages(): string[] {
  return LANGUAGE_REGISTRY.map(c => c.languageId);
}

/**
 * Check if a language server binary is available on the system.
 */
export function isLanguageServerAvailable(languageId: string): boolean {
  const config = getLanguageConfig(languageId);
  if (!config) return false;

  try {
    // Cross-platform: `command -v` works on Unix shells (bash/zsh) and Git Bash on Windows
    execSync(`command -v ${config.command}`, { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Discover all available language servers on the system.
 * Returns only languages whose server binary is found in PATH.
 */
export function discoverAvailableServers(): LanguageServerConfig[] {
  return LANGUAGE_REGISTRY.filter(config => {
    try {
      execSync(`command -v ${config.command}`, { stdio: 'ignore', timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Check if a language server supports a specific capability.
 */
export function hasCapability(languageId: string, capability: LSPCapability): boolean {
  const config = getLanguageConfig(languageId);
  return config?.capabilities.includes(capability) ?? false;
}

/**
 * Add a custom language server configuration at runtime.
 * Keeps both LANGUAGE_REGISTRY array and lookup maps in sync.
 */
export function registerLanguageServer(config: LanguageServerConfig): void {
  // Remove existing entry for the same languageId if present
  const idx = LANGUAGE_REGISTRY.findIndex(c => c.languageId === config.languageId);
  if (idx >= 0) {
    // Remove old extensions from map
    const oldConfig = LANGUAGE_REGISTRY[idx];
    for (const ext of oldConfig.extensions) {
      extensionToLanguage.delete(ext.toLowerCase());
    }
    LANGUAGE_REGISTRY[idx] = config;
  } else {
    LANGUAGE_REGISTRY.push(config);
  }

  // Update maps
  languageConfigMap.set(config.languageId, config);
  for (const ext of config.extensions) {
    extensionToLanguage.set(ext.toLowerCase(), config.languageId);
  }
}

/**
 * Extract file extension including the dot.
 */
function getExtension(filePath: string): string {
  const lastDot = filePath.lastIndexOf('.');
  if (lastDot < 0) return '';
  return filePath.slice(lastDot);
}
