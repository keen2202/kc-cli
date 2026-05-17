// Memory integration for QueryEngine
// Connects memory service to the query lifecycle

import type { ChatMessage } from '../types/message';
import type { MemoryConfig, MemoryEntry } from '../memory/types';
import { DEFAULT_MEMORY_CONFIG } from '../memory/types';
import { findRelevantMemories } from '../memory/relevanceSearch';
import type { MemoryManifestEntry } from '../memory/types';
import { extractMemoriesFromMessages as extractHeuristic } from '../services/memoryExtraction';

export interface MemoryIntegrationConfig {
  config?: Partial<MemoryConfig>;
  projectHash?: string;
  /** Callback to get memory manifest */
  getMemoryManifest?: () => Promise<MemoryManifestEntry[]>;
  /** Callback to get relevant memory content */
  getMemoryContent?: (fileName: string) => Promise<string | null>;
  /** Callback to save extracted memory */
  saveMemory?: (memory: MemoryEntry) => Promise<void>;
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

  constructor(options: MemoryIntegrationConfig) {
    this.config = { ...DEFAULT_MEMORY_CONFIG, ...options.config };
    this.projectHash = options.projectHash || 'default';

    // Default implementations (no-op if callbacks not provided)
    this.getMemoryManifest = options.getMemoryManifest || (async () => []);
    this.getMemoryContent = options.getMemoryContent || (async () => null);
    this.saveMemory = options.saveMemory || (async () => {});
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

      // Load memory content
      const memoryContents: string[] = [];
      for (const fileName of relevantFiles) {
        const content = await this.getMemoryContent(fileName);
        if (content) {
          memoryContents.push(content);
        }
      }

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
   * Uses heuristic-based extraction to find user preferences, project decisions,
   * and feedback/lessons from conversation messages.
   */
  async extractMemoriesFromConversation(messages: ChatMessage[]): Promise<void> {
    if (!this.config.enabled || !this.config.autoExtract) {
      return;
    }

    try {
      // Extract memories using heuristic patterns
      const extracted = await extractHeuristic(messages);

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
