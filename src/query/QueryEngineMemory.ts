import { logger } from '../services/logger';
// QueryEngine memory integration module

import { MemoryIntegration, createMemoryIntegration } from '../memory/integration';
import type { MemoryIntegrationConfig } from '../memory/integration';
import type { ToolDefinition } from '../tools/protocol';

/**
 * Manages memory integration for QueryEngine.
 * Handles loading relevant memories and maintaining memory context.
 */
export class MemoryHandler {
  private integration: MemoryIntegration;

  constructor(config: MemoryIntegrationConfig = {}) {
    this.integration = createMemoryIntegration(config);
  }

  /** Check if memory integration is enabled */
  isEnabled(): boolean {
    return this.integration.isEnabled();
  }

  /**
   * Load relevant memories for a given user message and tool set.
   * Returns formatted memory context string.
   */
  async loadRelevantMemories(userMessage: string, toolNames: string[]): Promise<string> {
    if (!this.integration.isEnabled()) {
      return '';
    }

    try {
      return await this.integration.loadRelevantMemories(userMessage, toolNames);
    } catch (_err) {
      logger.query.error("Suppressed error: " + String(_err));
      return '';
    }
  }

  /** Get the underlying memory integration */
  getIntegration(): MemoryIntegration {
    return this.integration;
  }
}
