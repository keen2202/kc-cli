/**
 * AGP Mem Adapter
 *
 * Bridges kc-cli memory configuration with the AGP RSPL layer.
 * Memory resources represent the memory subsystem (storage backend,
 * relevance search, consolidation) as evolvable RSPL resources.
 */

import type {
  MemoryConfig,
  MemoryEntry,
  MemoryType,
  DEFAULT_MEMORY_CONFIG,
} from '../../memory/protocol';
import type {
  ResourceRegistrationRecord,
  ResourceEntity,
  MemMetadata,
  ExportedRepresentation,
} from '../protocol';
import { createResourceEntity, createRegistrationRecord } from '../types';

// ─── Memory Config → RSPL Record ─────────────────────────────────────────────

/**
 * Extended memory config with AGP fields.
 * Wraps the base MemoryConfig with evolvability and versioning.
 */
export interface AGPMemoryConfig extends MemoryConfig {
  /** Optional name override */
  name?: string;
  /** AGP evolvability marker */
  agpEvolvability?: 0 | 1;
  /** AGP version */
  agpVersion?: string;
  /** Storage backend identifier */
  storageBackend?: string;
  /** Consolidation strategy name */
  consolidationStrategy?: string;
}

/**
 * Convert an AGPMemoryConfig to an AGP ResourceRegistrationRecord<'Mem'>.
 */
export function memConfigToRecord(config: AGPMemoryConfig): ResourceRegistrationRecord<'Mem'> {
  const name = config.name ?? 'memory-system';
  const description = `Memory subsystem (${config.storageBackend ?? 'file'} backend, ${config.enabled ? 'enabled' : 'disabled'})`;

  const metadata: MemMetadata = {
    storageBackend: config.storageBackend ?? 'file',
    relevanceConfig: {
      searchLimit: config.relevanceSearchLimit,
      maxMemoriesPerType: config.maxMemoriesPerType,
    },
    consolidationStrategy: config.consolidationStrategy ?? 'time-based',
  };

  const entity: ResourceEntity<'Mem'> = createResourceEntity('Mem', name, description, {
    evolvability: config.agpEvolvability ?? 1,
    ioMapping: {
      inputSchema: {
        type: 'object',
        properties: {
          projectHash: { type: 'string' },
          query: { type: 'string', description: 'Relevance search query' },
          memoryType: { type: 'string', enum: ['user', 'feedback', 'project', 'reference'] },
        },
      },
      outputSchema: {
        type: 'array',
        items: { type: 'object', description: 'MemoryEntry' },
      },
    },
    metadata,
  });

  const exportedRepresentations: ExportedRepresentation[] = [
    {
      format: 'text',
      content: [
        `Memory System: ${name}`,
        `  Enabled: ${config.enabled}`,
        `  Backend: ${config.storageBackend ?? 'file'}`,
        `  Auto-extract: ${config.autoExtract}`,
        `  Auto-consolidate: ${config.autoConsolidate}`,
        `  Max per type: ${config.maxMemoriesPerType}`,
        `  Relevance limit: ${config.relevanceSearchLimit}`,
      ].join('\n'),
    },
  ];

  return createRegistrationRecord(entity, {
    version: config.agpVersion ?? '1.0.0',
    implementationDescriptor: `memory/${name}`,
    instantiationParams: {
      enabled: config.enabled,
      autoExtract: config.autoExtract,
      autoConsolidate: config.autoConsolidate,
      idleThresholdMinutes: config.idleThresholdMinutes,
      consolidationMinHours: config.consolidationMinHours,
      consolidationMinSessions: config.consolidationMinSessions,
      extractionTurnThrottle: config.extractionTurnThrottle,
      maxMemoriesPerType: config.maxMemoriesPerType,
      maxSessionSnapshots: config.maxSessionSnapshots,
      sessionRetentionDays: config.sessionRetentionDays,
      relevanceSearchLimit: config.relevanceSearchLimit,
    },
    exportedRepresentations,
  });
}

// ─── RSPL Record → Memory Config ─────────────────────────────────────────────

/**
 * Convert an RSPL record back to a MemoryConfig.
 * Used when restoring memory configuration from the registry.
 */
export function recordToMemConfig(record: ResourceRegistrationRecord<'Mem'>): MemoryConfig {
  const p = record.instantiationParams;
  return {
    enabled: (p.enabled as boolean) ?? true,
    autoExtract: (p.autoExtract as boolean) ?? true,
    autoConsolidate: (p.autoConsolidate as boolean) ?? true,
    idleThresholdMinutes: (p.idleThresholdMinutes as number) ?? 5,
    consolidationMinHours: (p.consolidationMinHours as number) ?? 24,
    consolidationMinSessions: (p.consolidationMinSessions as number) ?? 5,
    extractionTurnThrottle: (p.extractionTurnThrottle as number) ?? 3,
    maxMemoriesPerType: (p.maxMemoriesPerType as number) ?? 50,
    maxSessionSnapshots: (p.maxSessionSnapshots as number) ?? 100,
    sessionRetentionDays: (p.sessionRetentionDays as number) ?? 30,
    sessionArchiveRetentionDays: (p.sessionArchiveRetentionDays as number) ?? 90,
    relevanceSearchLimit: (p.relevanceSearchLimit as number) ?? 5,
    llmExtraction: { enabled: (p.llmExtractionEnabled as boolean) ?? false },
    llmExtractionModel: p.llmExtractionModel as string | undefined,
    semanticDedupThreshold: (p.semanticDedupThreshold as number) ?? 0.85,
    llmTriggerOnFeedbackSignal: (p.llmTriggerOnFeedbackSignal as boolean) ?? true,
    maxExtractionCostUsdPerSession: p.maxExtractionCostUsdPerSession as number | undefined,
    failureBridging: (p.failureBridging as boolean) ?? false,
  };
}

/**
 * Apply AGP record changes back to an AGPMemoryConfig.
 * Used by SEPL Commit operator to propagate evolved state.
 */
export function applyRecordToMemConfig(
  config: AGPMemoryConfig,
  record: ResourceRegistrationRecord<'Mem'>
): AGPMemoryConfig {
  const base = recordToMemConfig(record);
  return {
    ...base,
    name: record.entity.name,
    agpEvolvability: record.entity.evolvability,
    agpVersion: record.version,
    storageBackend: record.entity.metadata.storageBackend ?? config.storageBackend,
    consolidationStrategy:
      record.entity.metadata.consolidationStrategy ?? config.consolidationStrategy,
  };
}

// ─── Memory Entry → RSPL Record ──────────────────────────────────────────────

/**
 * Convert a single MemoryEntry to a lightweight RSPL record.
 * This models an individual memory as a sub-resource of the Mem type.
 */
export function memoryEntryToRecord(
  entry: MemoryEntry,
  projectHash: string
): ResourceRegistrationRecord<'Mem'> {
  const name = `mem-${entry.fileName}`;
  const description = entry.header.description || `${entry.header.type} memory: ${entry.header.name}`;

  const metadata: MemMetadata = {
    storageBackend: 'file',
    relevanceConfig: {
      type: entry.header.type,
      confidence: entry.header.confidence ?? 'high',
    },
    consolidationStrategy: 'time-based',
  };

  const entity: ResourceEntity<'Mem'> = createResourceEntity('Mem', name, description, {
    evolvability: 1,
    ioMapping: {
      inputSchema: { type: 'string', description: 'Memory file path or query' },
      outputSchema: { type: 'string', description: 'Memory content' },
    },
    metadata,
  });

  return createRegistrationRecord(entity, {
    version: '1.0.0',
    implementationDescriptor: `memory/${projectHash}/${entry.fileName}`,
    instantiationParams: {
      projectHash,
      fileName: entry.fileName,
      memoryType: entry.header.type,
      createdAt: entry.header.createdAt,
    },
    exportedRepresentations: [
      {
        format: 'text',
        content: entry.content.slice(0, 500),
        label: 'memory-preview',
      },
    ],
  });
}

// ─── Batch Operations ────────────────────────────────────────────────────────

/**
 * Register memory configuration into an AGP registry.
 */
export function registerMemInRegistry(
  config: AGPMemoryConfig,
  registry: { register: (type: 'Mem', record: ResourceRegistrationRecord<'Mem'>) => string }
): string {
  const record = memConfigToRecord(config);
  return registry.register('Mem', record);
}

/**
 * Create a default AGPMemoryConfig from the standard MemoryConfig.
 */
export function wrapMemoryConfig(
  config: MemoryConfig,
  opts?: { storageBackend?: string; consolidationStrategy?: string }
): AGPMemoryConfig {
  return {
    ...config,
    name: 'memory-system',
    agpEvolvability: 1,
    agpVersion: '1.0.0',
    storageBackend: opts?.storageBackend ?? 'file',
    consolidationStrategy: opts?.consolidationStrategy ?? 'time-based',
  };
}
