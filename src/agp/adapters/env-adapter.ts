/**
 * AGP Env Adapter
 *
 * Bridges kc-cli ExecutionEnv configuration with the AGP RSPL layer.
 * Environment resources represent execution sandboxes (cwd, env vars,
 * shell backend) that can be versioned and evolved.
 */

import type { ExecutionEnv } from '../../services/execution-env';
import type {
  ResourceRegistrationRecord,
  ResourceEntity,
  EnvMetadata,
  ExportedRepresentation,
} from '../protocol';
import { createResourceEntity, createRegistrationRecord } from '../types';

// ─── Env Config → RSPL Record ───────────────────────────────────────────────

/**
 * Minimal environment configuration that can be registered as an RSPL resource.
 * This is a serializable subset of ExecutionEnv.
 */
export interface EnvConfig {
  /** Working directory */
  cwd: string;
  /** Environment variables */
  envVars?: Record<string, string>;
  /** Sandbox backend identifier */
  sandboxBackend?: string;
  /** Human-readable name for this environment */
  name?: string;
  /** Description */
  description?: string;
  /** AGP evolvability marker */
  agpEvolvability?: 0 | 1;
  /** AGP version */
  agpVersion?: string;
}

/**
 * Convert an EnvConfig to an AGP ResourceRegistrationRecord<'Env'>.
 */
export function envToRecord(config: EnvConfig): ResourceRegistrationRecord<'Env'> {
  const name = config.name ?? `env-${sanitizeName(config.cwd)}`;
  const description = config.description ?? `Execution environment for ${config.cwd}`;

  const metadata: EnvMetadata = {
    cwd: config.cwd,
    envVars: config.envVars ?? {},
    sandboxBackend: config.sandboxBackend ?? 'local',
  };

  const entity: ResourceEntity<'Env'> = createResourceEntity('Env', name, description, {
    evolvability: config.agpEvolvability ?? 0,
    ioMapping: {
      inputSchema: {
        type: 'object',
        properties: {
          cwd: { type: 'string' },
          envVars: { type: 'object', additionalProperties: { type: 'string' } },
        },
      },
      outputSchema: {
        type: 'object',
        properties: {
          shell: { type: 'object', description: 'Shell interface' },
          fs: { type: 'object', description: 'FileSystem interface' },
        },
      },
    },
    metadata,
  });

  const exportedRepresentations: ExportedRepresentation[] = [
    {
      format: 'text',
      content: `Environment: ${name}\n  cwd: ${config.cwd}\n  backend: ${config.sandboxBackend ?? 'local'}\n  vars: ${Object.keys(config.envVars ?? {}).length}`,
    },
  ];

  return createRegistrationRecord(entity, {
    version: config.agpVersion ?? '1.0.0',
    implementationDescriptor: `env/${name}`,
    instantiationParams: {
      cwd: config.cwd,
      envVars: config.envVars ?? {},
      sandboxBackend: config.sandboxBackend ?? 'local',
    },
    exportedRepresentations,
  });
}

// ─── ExecutionEnv → RSPL Record ─────────────────────────────────────────────

/**
 * Extract a serializable EnvConfig from a live ExecutionEnv instance.
 * Only captures configuration, not the fs/shell implementations.
 */
export function executionEnvToConfig(env: ExecutionEnv, name?: string): EnvConfig {
  return {
    cwd: env.cwd,
    name: name ?? `env-${sanitizeName(env.cwd)}`,
    description: `Execution environment for ${env.cwd}`,
    sandboxBackend: 'local',
  };
}

/**
 * Convert a live ExecutionEnv to an RSPL record.
 */
export function executionEnvToRecord(
  env: ExecutionEnv,
  name?: string
): ResourceRegistrationRecord<'Env'> {
  return envToRecord(executionEnvToConfig(env, name));
}

// ─── RSPL Record → Env Config ───────────────────────────────────────────────

/**
 * Convert an RSPL record back to an EnvConfig.
 * Used when restoring environment state from the registry.
 */
export function recordToEnvConfig(record: ResourceRegistrationRecord<'Env'>): EnvConfig {
  const params = record.instantiationParams;
  return {
    cwd: (params.cwd as string) ?? record.entity.metadata.cwd ?? '.',
    envVars: (params.envVars as Record<string, string>) ?? record.entity.metadata.envVars ?? {},
    sandboxBackend:
      (params.sandboxBackend as string) ?? record.entity.metadata.sandboxBackend ?? 'local',
    name: record.entity.name,
    description: record.entity.description,
    agpEvolvability: record.entity.evolvability,
    agpVersion: record.version,
  };
}

/**
 * Apply AGP record changes back to an EnvConfig.
 * Used by SEPL Commit operator to propagate evolved state.
 */
export function applyRecordToEnvConfig(
  config: EnvConfig,
  record: ResourceRegistrationRecord<'Env'>
): EnvConfig {
  return {
    ...config,
    cwd: record.entity.metadata.cwd ?? config.cwd,
    envVars: record.entity.metadata.envVars ?? config.envVars,
    sandboxBackend: record.entity.metadata.sandboxBackend ?? config.sandboxBackend,
    description: record.entity.description,
    agpEvolvability: record.entity.evolvability,
    agpVersion: record.version,
  };
}

// ─── Batch Operations ────────────────────────────────────────────────────────

/**
 * Register multiple environment configurations into an AGP registry.
 */
export function registerEnvsInRegistry(
  configs: EnvConfig[],
  registry: { register: (type: 'Env', record: ResourceRegistrationRecord<'Env'>) => string }
): number {
  let registered = 0;
  for (const config of configs) {
    try {
      const record = envToRecord(config);
      registry.register('Env', record);
      registered++;
    } catch {
      // Skip duplicates
    }
  }
  return registered;
}

/**
 * Create a default local environment configuration.
 */
export function createDefaultEnvConfig(cwd: string): EnvConfig {
  return {
    cwd,
    name: 'default-local',
    description: `Default local execution environment at ${cwd}`,
    sandboxBackend: 'local',
    envVars: {},
    agpEvolvability: 0,
    agpVersion: '1.0.0',
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sanitizeName(path: string): string {
  return path
    .replace(/[/\\]/g, '-')
    .replace(/[^a-zA-Z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(-32);
}
