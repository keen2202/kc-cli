// Configuration loading system

import { z } from 'zod';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

const ConfigSchema = z.object({
  // API Configuration
  apiKey: z.string().optional(),
  apiBaseUrl: z.string().optional(),
  model: z.string().default('claude-sonnet-4-20250514'),
  provider: z.enum(['anthropic', 'openai', 'ollama', 'deepseek', 'openai-compatible', 'qwen', 'glm']).default('anthropic'),

  // Permission Configuration
  permissionMode: z.enum(['default', 'bypassPermissions', 'dontAsk', 'plan', 'acceptEdits', 'auto']).default('default'),
  permissions: z.object({
    allow: z.array(z.string()).default([]),
    deny: z.array(z.string()).default([]),
    ask: z.array(z.string()).default([]),
  }).default({ allow: [], deny: [], ask: [] }),
  additionalDirectories: z.array(z.string()).default([]),

  // Tool Configuration
  toolTimeout: z.number().default(30),
  maxFileReadSize: z.number().default(100000), // 100KB
  maxOutputSize: z.number().default(10000), // 10KB

  // Database Configuration
  databaseConnections: z.record(z.string()).default({}),

  // Web Configuration
  searchProvider: z.enum(['tavily', 'google', 'bing', 'brave']).default('tavily'),
  searchApiKey: z.string().optional(),

  // Memory Configuration
  memory: z.object({
    enabled: z.boolean().default(true),
    autoExtract: z.boolean().default(true),
    autoConsolidate: z.boolean().default(true),
    idleThresholdMinutes: z.number().default(5),
    consolidationMinHours: z.number().default(24),
    consolidationMinSessions: z.number().default(5),
    extractionTurnThrottle: z.number().default(3),
    maxMemoriesPerType: z.number().default(50),
    maxSessionSnapshots: z.number().default(100),
    sessionRetentionDays: z.number().default(30),
    relevanceSearchLimit: z.number().default(5),
  }).default({}),

  // General
  verbose: z.boolean().default(false),
  color: z.boolean().default(true),
}).default({});

export type Config = z.infer<typeof ConfigSchema>;

export interface ConfigLayer {
  source: string;
  config: Partial<Config>;
}

/**
 * Load configuration from multiple layers (priority ascending):
 * 1. System defaults
 * 2. User config (~/.kc-cli/settings.json)
 * 3. Project config (.kc-cli/settings.json)
 * 4. Environment variables (KC_*)
 * 5. CLI arguments (passed separately)
 *
 * Optimization: User and project config files are read in parallel
 * to reduce startup latency.
 */
export async function loadConfig(cwd: string): Promise<{ config: Config; layers: ConfigLayer[] }> {
  const layers: ConfigLayer[] = [];

  // Layer 1: System defaults
  layers.push({
    source: 'defaults',
    config: ConfigSchema.parse({}),
  });

  // Layer 2 & 3: Read user and project config in parallel
  const userConfigPath = path.join(os.homedir(), '.kc-cli', 'settings.json');
  const projectConfigPath = path.join(cwd, '.kc-cli', 'settings.json');

  const [userConfig, projectConfig] = await Promise.all([
    loadConfigFile(userConfigPath),
    loadConfigFile(projectConfigPath),
  ]);

  if (userConfig) {
    layers.push({
      source: 'user',
      config: userConfig,
    });
  }

  if (projectConfig) {
    layers.push({
      source: 'project',
      config: projectConfig,
    });
  }

  // Layer 4: Environment variables
  const envConfig = loadEnvConfig();
  layers.push({
    source: 'env',
    config: envConfig,
  });

  // Merge all layers
  const merged = mergeConfigLayers(layers);
  const config = ConfigSchema.parse(merged);

  return { config, layers };
}

async function loadConfigFile(filePath: string): Promise<Partial<Config> | null> {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const content = await fs.promises.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(content);
    return parsed;
  } catch (error) {
    console.warn(`Failed to load config from ${filePath}:`, error);
    return null;
  }
}

function loadEnvConfig(): Partial<Config> {
  const config: Partial<Config> = {};

  if (process.env.KC_API_KEY) {
    config.apiKey = process.env.KC_API_KEY;
  }
  if (process.env.KC_API_BASE_URL) {
    config.apiBaseUrl = process.env.KC_API_BASE_URL;
  }
  if (process.env.KC_MODEL) {
    config.model = process.env.KC_MODEL;
  }
  if (process.env.KC_PROVIDER) {
    config.provider = process.env.KC_PROVIDER as Config['provider'];
  }
  if (process.env.KC_PERMISSION_MODE) {
    config.permissionMode = process.env.KC_PERMISSION_MODE as Config['permissionMode'];
  }
  if (process.env.KC_SEARCH_PROVIDER) {
    config.searchProvider = process.env.KC_SEARCH_PROVIDER as Config['searchProvider'];
  }
  if (process.env.KC_SEARCH_API_KEY) {
    config.searchApiKey = process.env.KC_SEARCH_API_KEY;
  }
  if (process.env.KC_VERBOSE) {
    config.verbose = process.env.KC_VERBOSE === 'true' || process.env.KC_VERBOSE === '1';
  }

  // Memory environment variables
  if (process.env.KC_MEMORY_ENABLED) {
    config.memory = config.memory || {} as any;
    (config.memory as any).enabled = process.env.KC_MEMORY_ENABLED === 'true' || process.env.KC_MEMORY_ENABLED === '1';
  }
  if (process.env.KC_MEMORY_AUTO_EXTRACT) {
    config.memory = config.memory || {} as any;
    (config.memory as any).autoExtract = process.env.KC_MEMORY_AUTO_EXTRACT === 'true' || process.env.KC_MEMORY_AUTO_EXTRACT === '1';
  }

  return config;
}

function mergeConfigLayers(layers: ConfigLayer[]): Partial<Config> {
  return layers.reduce((merged, layer) => {
    return deepMerge(merged, layer.config);
  }, {} as Partial<Config>);
}

function deepMerge<T extends Record<string, any>>(target: T, source: Partial<T>): T {
  const result = { ...target };

  for (const key in source) {
    if (source[key] === undefined) continue;

    if (
      typeof source[key] === 'object' &&
      source[key] !== null &&
      !Array.isArray(source[key]) &&
      typeof target[key] === 'object' &&
      target[key] !== null &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(target[key], source[key] as any);
    } else {
      result[key] = source[key] as any;
    }
  }

  return result;
}
