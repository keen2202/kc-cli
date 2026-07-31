// Memory integration for QueryEngine
// Connects memory service to the query lifecycle

import type { ChatMessage } from '../query/protocol';
import type { MemoryConfig, MemoryEntry } from '../memory/types';
import { DEFAULT_MEMORY_CONFIG } from '../memory/types';
import { findRelevantMemories, invalidateScoreCache } from '../memory/relevanceSearch';
import type { MemoryManifestEntry } from '../memory/types';
import type { EvidenceBundle, EvidenceCluster } from '../agp/sepl/protocol';
import {
  extractMemoriesHybrid,
  type LlmExtractionClient,
} from './memoryExtraction';
import type { BudgetEnforcer } from '../services/budget';

export interface MemoryIntegrationConfig {
  config?: Partial<MemoryConfig>;
  projectHash?: string;
  /** Callback to get memory manifest */
  getMemoryManifest?: () => Promise<MemoryManifestEntry[]>;
  /** Callback to get relevant memory content */
  getMemoryContent?: (fileName: string) => Promise<string | null>;
  /** Callback to save extracted memory */
  saveMemory?: (memory: MemoryEntry) => Promise<void>;
  /** Optional isolated LLM client for the hybrid extraction tier (T3). */
  llmClient?: LlmExtractionClient | null;
  /** Optional budget enforcer gating LLM extraction cost (T2/GR6). */
  budget?: BudgetEnforcer | null;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

/** Minimum cluster occurrence count before a failure signature is bridged (T8). */
const DEFAULT_BRIDGE_THRESHOLD = 2;

/** Slug for deterministic failure-memory file names. */
function signatureSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

/** Deterministic file name so re-bridging the same signature merges, never forks. */
function failureMemoryFileName(cluster: EvidenceCluster): string {
  const { terminalCause, mechanism } = cluster.signature;
  return `failure-${signatureSlug(terminalCause)}-${signatureSlug(mechanism)}.md`;
}

/**
 * Render the bridged memory body, separating verifier-level facts (observed,
 * countable) from the inferred mechanism (deterministic heuristic) per T8.
 * The `Occurrences:` line doubles as the merge-update count anchor.
 */
function renderFailureMemoryBody(cluster: EvidenceCluster, totalCount: number): string {
  const lines: string[] = ['## Verifier-level facts', ''];
  lines.push(`- Terminal cause: ${cluster.signature.terminalCause}`);
  lines.push(`- Occurrences: ${totalCount}`);
  if (cluster.sharedSymptoms.length > 0) {
    lines.push('- Shared symptoms:');
    for (const symptom of cluster.sharedSymptoms) {
      lines.push(`  - ${symptom}`);
    }
  }
  if (cluster.representativeEvents.length > 0) {
    lines.push('- Representative events:');
    for (const event of cluster.representativeEvents) {
      lines.push(`  - [${event.source}] ${event.message}`);
    }
  }
  lines.push('', '## Inferred mechanism', '');
  lines.push(`- Mechanism: ${cluster.signature.mechanism}`);
  lines.push(`- Causal status: ${cluster.signature.causalStatus}`);
  return lines.join('\n');
}

/**
 * Memory integration service for QueryEngine
 * Provides pre-query memory loading and post-query memory extraction
 */
export class MemoryIntegration {
  private config: MemoryConfig;
  private projectHash: string;
  private getMemoryManifest: () => Promise<MemoryManifestEntry[]>;
  private getMemoryContent: (fileName: string) => Promise<string | null>;
  private saveMemory: (memory: MemoryEntry) => Promise<void>;
  private memoryLoadPromise: Promise<string> | null = null;
  private llmClient: LlmExtractionClient | null;
  private budget: BudgetEnforcer | null;
  private now: () => number;

  constructor(options: MemoryIntegrationConfig) {
    this.config = { ...DEFAULT_MEMORY_CONFIG, ...options.config };
    this.projectHash = options.projectHash || 'default';

    // Default implementations (no-op if callbacks not provided)
    this.getMemoryManifest = options.getMemoryManifest || (async () => []);
    this.getMemoryContent = options.getMemoryContent || (async () => null);
    this.saveMemory = options.saveMemory || (async () => {});
    this.llmClient = options.llmClient ?? null;
    this.budget = options.budget ?? null;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Pre-query: Load relevant memories into system prompt
   * Returns memory context string to prepend to system prompt
   */
  async loadRelevantMemories(query: string, recentTools?: string[]): Promise<string> {
    if (!this.config.enabled) {
      return '';
    }

    try {
      // Get memory manifest
      const manifest = await this.getMemoryManifest();
      if (manifest.length === 0) {
        return '';
      }

      // Find relevant memories
      const relevantFiles = findRelevantMemories(
        query,
        manifest,
        recentTools,
        this.config.relevanceSearchLimit
      );

      if (relevantFiles.length === 0) {
        return '';
      }

      // Load memory content in parallel
      const contentPromises = relevantFiles.map(fileName => this.getMemoryContent(fileName));
      const contents = await Promise.all(contentPromises);
      const memoryContents = contents.filter((content): content is string => content !== null);

      if (memoryContents.length === 0) {
        return '';
      }

      // Format as context for system prompt
      return `\n\n# Relevant Memories\n\n${memoryContents.join('\n\n---\n\n')}`;
    } catch (error) {
      console.warn('[MemoryIntegration] Failed to load memories:', error);
      return '';
    }
  }

  /**
   * Post-query: Extract and save memories from conversation.
   * Runs the hybrid two-tier pipeline (heuristic gate + optional isolated LLM
   * fine-extraction). When the LLM tier is disabled/unavailable this is
   * byte-for-byte equivalent to the previous heuristic-only behaviour.
   */
  async extractMemoriesFromConversation(messages: ChatMessage[]): Promise<void> {
    if (!this.config.enabled || !this.config.autoExtract) {
      return;
    }

    try {
      // Hybrid extraction (heuristic gate + optional guarded LLM tier).
      const extracted = await extractMemoriesHybrid(messages, {
        config: this.config,
        client: this.llmClient,
        budget: this.budget,
        getExistingManifest: this.getMemoryManifest,
        now: this.now,
      });

      if (extracted.length === 0) {
        return;
      }

      // Deduplicate: check if similar memories already exist
      const manifest = await this.getMemoryManifest();
      const existingNames = new Set(manifest.map(m => m.fileName));

      let savedCount = 0;
      for (const memory of extracted) {
        // Skip if a memory with this name already exists
        if (existingNames.has(memory.fileName)) {
          continue;
        }

        try {
          await this.saveMemory(memory);
          savedCount++;
        } catch (err) {
          console.warn('[MemoryIntegration] Failed to save extracted memory:', err);
        }
      }

      if (savedCount > 0) {
        console.log(`[MemoryIntegration] Extracted and saved ${savedCount} memories`);
      }
    } catch (error) {
      console.warn('[MemoryIntegration] Failed to extract memories:', error);
    }
  }

  /**
   * T8: Bridge recurring failure signatures into feedback memories.
   * Gated by `memory.failureBridging` (default false — zero behaviour change).
   * Clusters below the occurrence threshold are skipped; a signature that was
   * bridged before is merged into the existing memory (count accumulates)
   * instead of creating a duplicate.
   */
  async bridgeFailureSignatures(
    evidence: EvidenceBundle,
    opts?: { threshold?: number }
  ): Promise<void> {
    if (!this.config.enabled || !this.config.failureBridging) {
      return;
    }

    const threshold = opts?.threshold ?? DEFAULT_BRIDGE_THRESHOLD;
    try {
      const eligible = evidence.clusters.filter(c => c.count >= threshold);
      if (eligible.length === 0) {
        return;
      }

      const manifest = await this.getMemoryManifest();
      let savedCount = 0;
      for (const cluster of eligible) {
        try {
          await this.bridgeCluster(cluster, manifest);
          savedCount++;
        } catch (err) {
          console.warn('[MemoryIntegration] Failed to bridge failure signature:', err);
        }
      }

      if (savedCount > 0) {
        // Bridged memories change manifest signatures/descriptions — drop stale scores.
        invalidateScoreCache();
      }
    } catch (error) {
      console.warn('[MemoryIntegration] Failed to bridge failure signatures:', error);
    }
  }

  /** Merge-or-create a single failure cluster as a feedback memory. */
  private async bridgeCluster(
    cluster: EvidenceCluster,
    manifest: MemoryManifestEntry[]
  ): Promise<void> {
    const { terminalCause, mechanism } = cluster.signature;

    // Dedup by signature match (mechanism + terminalCause); deterministic
    // file name is the fallback for legacy entries without a manifest signature.
    const existing =
      manifest.find(
        m => m.signature?.terminalCause === terminalCause && m.signature?.mechanism === mechanism
      ) ?? manifest.find(m => m.fileName === failureMemoryFileName(cluster));

    const previousCount =
      existing?.signature?.count ??
      (existing ? await this.readOccurrenceCount(existing.fileName) : 0);
    const totalCount = previousCount + cluster.count;

    const now = this.now();
    const entry: MemoryEntry = {
      header: {
        name: `Recurring failure: ${terminalCause}`,
        description: `Recurring ${mechanism} failure (${terminalCause}) observed ${totalCount} time(s)`,
        type: 'feedback',
        createdAt: existing ? undefined : now,
        updatedAt: now,
        signature: { terminalCause, mechanism, count: totalCount },
      },
      content: renderFailureMemoryBody(cluster, totalCount),
      filePath: '',
      fileName: existing?.fileName ?? failureMemoryFileName(cluster),
      mtime: now,
    };

    // saveMemory overwrites the same fileName → merge update, never a duplicate.
    await this.saveMemory(entry);
  }

  /** Fallback occurrence count parser (`Occurrences: N` anchor in the body). */
  private async readOccurrenceCount(fileName: string): Promise<number> {
    const content = await this.getMemoryContent(fileName);
    if (!content) return 0;
    const match = content.match(/Occurrences:\s*(\d+)/);
    return match ? parseInt(match[1], 10) : 0;
  }

  /**
   * Check if idle consolidation should run
   * Returns true if consolidation conditions are met
   */
  shouldRunConsolidation(
    sessionsSinceLastConsolidation: number,
    hoursSinceLastConsolidation: number
  ): boolean {
    if (!this.config.enabled || !this.config.autoConsolidate) {
      return false;
    }

    return (
      sessionsSinceLastConsolidation >= this.config.consolidationMinSessions &&
      hoursSinceLastConsolidation >= this.config.consolidationMinHours
    );
  }

  /**
   * Get memory configuration
   */
  getConfig(): MemoryConfig {
    return { ...this.config };
  }

  /**
   * Update memory configuration
   */
  updateConfig(updates: Partial<MemoryConfig>): void {
    this.config = { ...this.config, ...updates };
  }

  /**
   * Check if memory system is enabled
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }
}

/**
 * Create MemoryIntegration instance from config
 * Factory function for easy integration with QueryEngine
 */
export function createMemoryIntegration(
  options: MemoryIntegrationConfig
): MemoryIntegration {
  return new MemoryIntegration(options);
}
