// Configuration loading system

import { z } from 'zod';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { logger } from '../services/logger';

export const ConfigSchema = z.object({
  // API Configuration
  apiKey: z.string().optional(),
  apiBaseUrl: z.string().optional(),
  model: z.string().default('deepseek-v4-pro'),
  provider: z.enum(['anthropic', 'openai', 'ollama', 'deepseek', 'openai-compatible', 'qwen', 'glm', 'mimo', 'kimi', 'step', 'gemini']).default('deepseek'),

  // Permission Configuration
  permissionMode: z.enum(['default', 'bypassPermissions', 'dontAsk', 'plan', 'acceptEdits', 'auto']).default('default'),
  permissions: z.object({
    allow: z.array(z.string()).default([]),
    deny: z.array(z.string()).default([]),
    ask: z.array(z.string()).default([]),
  }).default({ allow: [], deny: [], ask: [] }),
  additionalDirectories: z.array(z.string()).default([]),
  // T1 (H1): fail-safe policy for 'ask' decisions in non-interactive contexts
  // (no UI approval handler). 'deny' (default) refuses; 'allow'/'proceed' opt in.
  noninteractiveAskPolicy: z.enum(['deny', 'allow', 'proceed']).default('deny'),

  // Tool Configuration
  toolTimeout: z.number().default(30),
  maxFileReadSize: z.number().default(100000), // 100KB
  maxOutputSize: z.number().default(10000), // 10KB

  // Database Configuration
  databaseConnections: z.record(z.object({
    type: z.enum(['sqlite', 'postgres', 'mysql']),
    path: z.string().optional(),     // for sqlite
    host: z.string().optional(),     // for postgres/mysql
    port: z.number().optional(),
    database: z.string().optional(),
    user: z.string().optional(),
    password: z.string().optional(),
    readonly: z.boolean().optional(),
  })).default({}),

  // SQL Tool Security Configuration (S1 hardening)
  sql: z.object({
    /** Whitelist of allowed database file paths. Ad-hoc paths outside this list are rejected. */
    allowedPaths: z.array(z.string()).default([]),
    /** When false (default), write queries (INSERT/UPDATE/DELETE/CREATE/DROP/ALTER) are rejected. */
    allowWrite: z.boolean().default(false),
  }).default({}),

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
    sessionArchiveRetentionDays: z.number().default(90),
    relevanceSearchLimit: z.number().default(5),
    // ── LLM semantic extraction (T6) — off by default (zero behaviour change) ──
    llmExtraction: z.object({
      enabled: z.boolean().default(false),
    }).default({}),
    llmExtractionModel: z.string().optional(),
    semanticDedupThreshold: z.number().min(0).max(1).default(0.85),
    llmTriggerOnFeedbackSignal: z.boolean().default(true),
    maxExtractionCostUsdPerSession: z.number().min(0).optional(),
  }).default({}),

  // Sandbox Configuration
  sandbox: z.object({
    enabled: z.boolean().default(true),
    backend: z.enum(['bubblewrap', 'seccomp', 'docker', 'noop']).default('bubblewrap'),
    allowNetwork: z.boolean().default(false),
    maxMemoryMb: z.number().default(512),
    cpuTimeLimitSec: z.number().default(60),
    /** If true, throw an error instead of silently falling back to noop sandbox */
    failIfNoSandbox: z.boolean().default(true),
    /** Default enforcement level for tools not explicitly configured */
    defaultEnforcement: z.enum(['required', 'preferred', 'optional', 'excluded', 'inherit']).default('preferred'),
    /** Per-tool sandbox policy overrides keyed by tool name */
    toolPolicies: z.record(
      z.object({
        allowNetwork: z.boolean().optional(),
        maxMemoryMb: z.number().optional(),
        cpuTimeLimitSec: z.number().optional(),
        enforcement: z.enum(['required', 'preferred', 'optional', 'excluded', 'inherit']).optional(),
      })
    ).default({}),
    /** Pattern-based rules for tool name matching */
    patternRules: z.array(
      z.object({
        pattern: z.string(),
        policy: z.object({
          allowNetwork: z.boolean().optional(),
          maxMemoryMb: z.number().optional(),
          cpuTimeLimitSec: z.number().optional(),
          enforcement: z.enum(['required', 'preferred', 'optional', 'excluded', 'inherit']).optional(),
        }),
      })
    ).default([]),
  }).default({}),

  // MCP Configuration
  mcp: z.object({
    enabled: z.boolean().default(true),
  }).default({}),

  // IM Platform Integration
  im: z.object({
    enabled: z.boolean().default(false),
    adapters: z.object({
      feishu: z.object({
        enabled: z.boolean().default(false),
        appId: z.string().optional(),
        appSecret: z.string().optional(),
        options: z.record(z.unknown()).optional(),
      }).default({ enabled: false }),
      wecom: z.object({
        enabled: z.boolean().default(false),
        appId: z.string().optional(),
        appSecret: z.string().optional(),
        options: z.record(z.unknown()).optional(),
      }).default({ enabled: false }),
      dingtalk: z.object({
        enabled: z.boolean().default(false),
        appId: z.string().optional(),
        appSecret: z.string().optional(),
        options: z.record(z.unknown()).optional(),
      }).default({ enabled: false }),
    }).default({}),
    session: z.object({
      timeoutMinutes: z.number().default(30),
      maxSessions: z.number().default(100),
      maxQueueSize: z.number().default(10),
    }).default({}),
  }).default({ enabled: false }),

  // Agent Turn Configuration
  maxTurns: z.number().default(80),
  // Auto-extend the turn budget while the agent is actively making progress
  // (editing files or issuing tool calls). Default ON so long-running tasks
  // are not force-stopped at the initial maxTurns; a stalled agent (no
  // progress in the last 5 turns) still stops at the current budget.
  autoExtendTurns: z.boolean().default(true),
  // Hard ceiling for auto-extended turns. 0 (or negative) = unbounded: an
  // actively-progressing task is never cut off by a turn ceiling.
  maxTurnsCeiling: z.number().default(400),
  // Minimum turns before the agent may exit (0 = disabled). Guards long tasks
  // against premature abandonment during read/exploration-heavy phases.
  minTurns: z.number().default(0),
  // Periodic auto-commit checkpoint interval in turns (0 = disabled). Default
  // ON (every 10 turns) so long-running task progress survives an
  // interruption/crash between turns; commits are best-effort no-ops outside
  // a git repository or when nothing changed.
  autoCommitInterval: z.number().default(10),

  // General
  verbose: z.boolean().default(false),
  color: z.boolean().default(true),
}).default({});

export type Config = z.infer<typeof ConfigSchema>;

// Unwrap ConfigSchema's ZodDefault wrapper to access .shape for env validation
const _configObject: z.ZodObject<any> = (() => {
  const s: z.ZodTypeAny = ConfigSchema;
  return s._def.typeName === 'ZodDefault'
    ? (s as unknown as z.ZodDefault<any>)._def.innerType as z.ZodObject<any>
    : s as unknown as z.ZodObject<any>;
})();

// Enum schemas used for environment variable validation (QUAL-04)
const providerSchema = _configObject.shape.provider;
const permissionModeSchema = _configObject.shape.permissionMode;
const noninteractiveAskPolicySchema = _configObject.shape.noninteractiveAskPolicy;
const searchProviderSchema = _configObject.shape.searchProvider;
const sandboxBackendSchema = (() => {
  const sb = _configObject.shape.sandbox;
  const inner = sb._def.typeName === 'ZodDefault'
    ? (sb as unknown as z.ZodDefault<any>)._def.innerType as z.ZodObject<any>
    : sb as unknown as z.ZodObject<any>;
  return inner.shape.backend;
})();
const sandboxEnforcementSchema = (() => {
  const sb = _configObject.shape.sandbox;
  const inner = sb._def.typeName === 'ZodDefault'
    ? (sb as unknown as z.ZodDefault<any>)._def.innerType as z.ZodObject<any>
    : sb as unknown as z.ZodObject<any>;
  return inner.shape.defaultEnforcement;
})();

export interface ConfigLayer {
  source: string;
  config: Partial<Config>;
}

/**
 * Load environment variables from `<cwd>/.env` into process.env.
 *
 * Lightweight parser (no dotenv dependency):
 * - Skips blank lines and comment lines
 * - Supports `KEY=VALUE` (optional `export ` prefix)
 * - Strips inline `# comment` from unquoted values (.env.example style)
 * - Strips matching single/double quotes around values
 * - Never overwrites variables already present in process.env,
 *   preserving the env > .env precedence
 *
 * Safe to call multiple times; a missing .env file is a no-op.
 */
export function loadDotEnv(cwd: string): void {
  const envPath = path.join(cwd, '.env');
  let content: string;
  try {
    content = fs.readFileSync(envPath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      logger.services.warn(`Failed to read .env from ${envPath}: ` + String(error));
    }
    return;
  }

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eqIndex = line.indexOf('=');
    if (eqIndex <= 0) continue;

    let key = line.slice(0, eqIndex).trim();
    if (key.startsWith('export ')) key = key.slice('export '.length).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = line.slice(eqIndex + 1).trim();
    const isQuoted =
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")));
    if (isQuoted) {
      value = value.slice(1, -1);
    } else {
      // Strip inline comments from unquoted values (e.g. `KC_PROVIDER=anthropic  # note`)
      const hashIndex = value.indexOf('#');
      if (hashIndex !== -1) {
        value = value.slice(0, hashIndex).trim();
      }
    }

    // Real environment always wins over .env
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
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

  // Load .env into process.env before reading KC_* env vars, so values in a
  // project .env file (e.g. KC_API_KEY) are picked up by loadEnvConfig().
  loadDotEnv(cwd);

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

export async function loadConfigFile(filePath: string): Promise<Partial<Config> | null> {
  try {
    // Direct async read instead of sync existsSync + async readFile (eliminates TOCTOU race and extra syscall)
    const content = await fs.promises.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(content);
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    logger.services.warn(`Failed to load config from ${filePath}: ` + String(error));
    return null;
  }
}

export function loadEnvConfig(): Partial<Config> {
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
    const result = providerSchema.safeParse(process.env.KC_PROVIDER);
    if (result.success) {
      config.provider = result.data;
    } else {
      logger.services.warn(`Invalid KC_PROVIDER value: "${process.env.KC_PROVIDER}" -- discarding`);
    }
  }
  if (process.env.KC_PERMISSION_MODE) {
    const result = permissionModeSchema.safeParse(process.env.KC_PERMISSION_MODE);
    if (result.success) {
      config.permissionMode = result.data;
    } else {
      logger.services.warn(`Invalid KC_PERMISSION_MODE value: "${process.env.KC_PERMISSION_MODE}" -- discarding`);
    }
  }
  if (process.env.KC_NONINTERACTIVE_ASK_POLICY) {
    const result = noninteractiveAskPolicySchema.safeParse(process.env.KC_NONINTERACTIVE_ASK_POLICY);
    if (result.success) {
      config.noninteractiveAskPolicy = result.data;
    } else {
      logger.services.warn(`Invalid KC_NONINTERACTIVE_ASK_POLICY value: "${process.env.KC_NONINTERACTIVE_ASK_POLICY}" -- discarding`);
    }
  }
  if (process.env.KC_SEARCH_PROVIDER) {
    const result = searchProviderSchema.safeParse(process.env.KC_SEARCH_PROVIDER);
    if (result.success) {
      config.searchProvider = result.data;
    } else {
      logger.services.warn(`Invalid KC_SEARCH_PROVIDER value: "${process.env.KC_SEARCH_PROVIDER}" -- discarding`);
    }
  }
  if (process.env.KC_SEARCH_API_KEY) {
    config.searchApiKey = process.env.KC_SEARCH_API_KEY;
  }
  if (process.env.KC_VERBOSE) {
    config.verbose = process.env.KC_VERBOSE === 'true' || process.env.KC_VERBOSE === '1';
  }

  // Agent turn configuration environment variables
  if (process.env.KC_MAX_TURNS) {
    const parsed = parseInt(process.env.KC_MAX_TURNS, 10);
    if (Number.isFinite(parsed)) {
      config.maxTurns = parsed;
    } else {
      logger.services.warn(`Invalid KC_MAX_TURNS value: "${process.env.KC_MAX_TURNS}" -- using default`);
    }
  }
  if (process.env.KC_AUTO_EXTEND_TURNS) {
    config.autoExtendTurns = process.env.KC_AUTO_EXTEND_TURNS === 'true' || process.env.KC_AUTO_EXTEND_TURNS === '1';
  }
  if (process.env.KC_MAX_TURNS_CEILING) {
    const parsed = parseInt(process.env.KC_MAX_TURNS_CEILING, 10);
    if (Number.isFinite(parsed)) {
      config.maxTurnsCeiling = parsed;
    } else {
      logger.services.warn(`Invalid KC_MAX_TURNS_CEILING value: "${process.env.KC_MAX_TURNS_CEILING}" -- using default`);
    }
  }
  if (process.env.KC_MIN_TURNS) {
    const parsed = parseInt(process.env.KC_MIN_TURNS, 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      config.minTurns = parsed;
    } else {
      logger.services.warn(`Invalid KC_MIN_TURNS value: "${process.env.KC_MIN_TURNS}" -- using default`);
    }
  }
  if (process.env.KC_AUTO_COMMIT_INTERVAL) {
    const parsed = parseInt(process.env.KC_AUTO_COMMIT_INTERVAL, 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      config.autoCommitInterval = parsed;
    } else {
      logger.services.warn(`Invalid KC_AUTO_COMMIT_INTERVAL value: "${process.env.KC_AUTO_COMMIT_INTERVAL}" -- using default`);
    }
  }

  // Sandbox environment variables
  if (!config.sandbox) config.sandbox = {} as Partial<Config['sandbox']> as Config['sandbox'];
  const sb = config.sandbox;
  if (process.env.KC_SANDBOX_ENABLED) {
    sb.enabled = process.env.KC_SANDBOX_ENABLED === 'true' || process.env.KC_SANDBOX_ENABLED === '1';
  }
  if (process.env.KC_SANDBOX_BACKEND) {
    const result = sandboxBackendSchema.safeParse(process.env.KC_SANDBOX_BACKEND);
    if (result.success) {
      sb.backend = result.data;
    } else {
      logger.services.warn(`Invalid KC_SANDBOX_BACKEND value: "${process.env.KC_SANDBOX_BACKEND}" -- discarding`);
    }
  }
  if (process.env.KC_SANDBOX_ALLOW_NETWORK) {
    sb.allowNetwork = process.env.KC_SANDBOX_ALLOW_NETWORK === 'true' || process.env.KC_SANDBOX_ALLOW_NETWORK === '1';
  }
  if (process.env.KC_SANDBOX_MAX_MEMORY_MB) {
    const parsed = parseInt(process.env.KC_SANDBOX_MAX_MEMORY_MB, 10);
    if (Number.isFinite(parsed)) {
      sb.maxMemoryMb = parsed;
    } else {
      logger.services.warn(`Invalid KC_SANDBOX_MAX_MEMORY_MB value: "${process.env.KC_SANDBOX_MAX_MEMORY_MB}" -- using default`);
    }
  }
  if (process.env.KC_SANDBOX_CPU_TIME_LIMIT_SEC) {
    const parsed = parseInt(process.env.KC_SANDBOX_CPU_TIME_LIMIT_SEC, 10);
    if (Number.isFinite(parsed)) {
      sb.cpuTimeLimitSec = parsed;
    } else {
      logger.services.warn(`Invalid KC_SANDBOX_CPU_TIME_LIMIT_SEC value: "${process.env.KC_SANDBOX_CPU_TIME_LIMIT_SEC}" -- using default`);
    }
  }
  if (process.env.KC_SANDBOX_FAIL_IF_NO_SANDBOX) {
    sb.failIfNoSandbox = process.env.KC_SANDBOX_FAIL_IF_NO_SANDBOX === 'true' || process.env.KC_SANDBOX_FAIL_IF_NO_SANDBOX === '1';
  }
  if (process.env.KC_SANDBOX_DEFAULT_ENFORCEMENT) {
    const result = sandboxEnforcementSchema.safeParse(process.env.KC_SANDBOX_DEFAULT_ENFORCEMENT);
    if (result.success) {
      sb.defaultEnforcement = result.data;
    } else {
      logger.services.warn(`Invalid KC_SANDBOX_DEFAULT_ENFORCEMENT value: "${process.env.KC_SANDBOX_DEFAULT_ENFORCEMENT}" -- discarding`);
    }
  }
  if (process.env.KC_SANDBOX_TOOL_POLICIES) {
    try {
      sb.toolPolicies = JSON.parse(process.env.KC_SANDBOX_TOOL_POLICIES);
    } catch {
      logger.services.warn('Failed to parse KC_SANDBOX_TOOL_POLICIES environment variable');
    }
  }

  // Memory environment variables
  if (!config.memory) config.memory = {} as Partial<Config['memory']> as Config['memory'];
  const mem = config.memory;
  if (process.env.KC_MEMORY_ENABLED) {
    mem.enabled = process.env.KC_MEMORY_ENABLED === 'true' || process.env.KC_MEMORY_ENABLED === '1';
  }
  if (process.env.KC_MEMORY_AUTO_EXTRACT) {
    mem.autoExtract = process.env.KC_MEMORY_AUTO_EXTRACT === 'true' || process.env.KC_MEMORY_AUTO_EXTRACT === '1';
  }
  if (process.env.KC_MEMORY_LLM_EXTRACTION) {
    if (!mem.llmExtraction) mem.llmExtraction = {} as Config['memory']['llmExtraction'];
    mem.llmExtraction.enabled =
      process.env.KC_MEMORY_LLM_EXTRACTION === 'true' || process.env.KC_MEMORY_LLM_EXTRACTION === '1';
  }
  if (process.env.KC_MEMORY_LLM_EXTRACTION_MODEL) {
    mem.llmExtractionModel = process.env.KC_MEMORY_LLM_EXTRACTION_MODEL;
  }
  if (process.env.KC_MEMORY_SEMANTIC_DEDUP_THRESHOLD) {
    const raw = Number(process.env.KC_MEMORY_SEMANTIC_DEDUP_THRESHOLD);
    if (Number.isFinite(raw) && raw >= 0 && raw <= 1) {
      mem.semanticDedupThreshold = raw;
    } else {
      logger.services.warn(`Invalid KC_MEMORY_SEMANTIC_DEDUP_THRESHOLD value: "${process.env.KC_MEMORY_SEMANTIC_DEDUP_THRESHOLD}" -- discarding`);
    }
  }
  if (process.env.KC_MEMORY_LLM_TRIGGER_ON_FEEDBACK) {
    mem.llmTriggerOnFeedbackSignal =
      process.env.KC_MEMORY_LLM_TRIGGER_ON_FEEDBACK === 'true' || process.env.KC_MEMORY_LLM_TRIGGER_ON_FEEDBACK === '1';
  }
  if (process.env.KC_MEMORY_MAX_EXTRACTION_COST_USD) {
    const raw = Number(process.env.KC_MEMORY_MAX_EXTRACTION_COST_USD);
    if (Number.isFinite(raw) && raw >= 0) {
      mem.maxExtractionCostUsdPerSession = raw;
    } else {
      logger.services.warn(`Invalid KC_MEMORY_MAX_EXTRACTION_COST_USD value: "${process.env.KC_MEMORY_MAX_EXTRACTION_COST_USD}" -- discarding`);
    }
  }

  // IM environment variables
  if (!config.im) config.im = {} as Partial<Config['im']> as Config['im'];
  const im = config.im;
  if (process.env.KC_IM_ENABLED) {
    im.enabled = process.env.KC_IM_ENABLED === 'true' || process.env.KC_IM_ENABLED === '1';
  }
  if (!im.adapters) im.adapters = {} as any;
  if (!im.adapters.feishu) im.adapters.feishu = {} as any;
  if (process.env.KC_IM_FEISHU_ENABLED) {
    im.adapters.feishu.enabled = process.env.KC_IM_FEISHU_ENABLED === 'true' || process.env.KC_IM_FEISHU_ENABLED === '1';
  }
  if (process.env.KC_IM_FEISHU_APP_ID) {
    im.adapters.feishu.appId = process.env.KC_IM_FEISHU_APP_ID;
  }
  if (process.env.KC_IM_FEISHU_APP_SECRET) {
    im.adapters.feishu.appSecret = process.env.KC_IM_FEISHU_APP_SECRET;
  }

  return config;
}

export function mergeConfigLayers(layers: ConfigLayer[]): Partial<Config> {
  return layers.reduce((merged, layer) => {
    return deepMerge(merged, layer.config);
  }, {} as Partial<Config>);
}

export function deepMerge<T extends Record<string, unknown>>(target: T, source: Partial<T>): T {
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
      // Recursive merge for nested objects — cast needed because TypeScript
      // cannot track that both sides are Record<string, unknown>
      const nestedTarget = target[key] as Record<string, unknown>;
      const nestedSource = source[key] as Record<string, unknown>;
      (result as Record<string, unknown>)[key] = deepMerge(nestedTarget, nestedSource);
    } else if (Array.isArray(source[key]) && Array.isArray(target[key])) {
      // QUAL-02: Concatenate arrays instead of replacing
      (result as Record<string, unknown>)[key] = [...(target[key] as unknown[]), ...(source[key] as unknown[])];
    } else {
      (result as Record<string, unknown>)[key] = source[key];
    }
  }

  return result;
}
