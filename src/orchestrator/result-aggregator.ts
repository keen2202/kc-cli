// Result aggregation system for multi-agent coordination

import type { SubAgentResult, AggregatedResult, SubAgentSpawnConfig } from './types.js';

interface ExpectedAgent {
  config: SubAgentSpawnConfig;
  status: 'pending' | 'completed' | 'failed' | 'timed_out' | 'cancelled';
  result?: SubAgentResult;
  error?: string;
}

/**
 * ResultAggregator - Collects and formats results from multiple sub-agents
 */
export class ResultAggregator {
  private expectedAgents: Map<string, ExpectedAgent> = new Map();
  private startedAt: number = Date.now();

  /**
   * Register an expected sub-agent
   */
  register(agentId: string, config: SubAgentSpawnConfig): void {
    this.expectedAgents.set(agentId, {
      config,
      status: 'pending',
    });
  }

  /**
   * Record a successful completion
   */
  recordResult(result: SubAgentResult): void {
    const agent = this.expectedAgents.get(result.agentId);
    if (agent) {
      agent.status = 'completed';
      agent.result = result;
    } else {
      // Agent was not registered, add it now
      this.expectedAgents.set(result.agentId, {
        config: {
          name: result.name,
          prompt: '',
          systemPromptMode: 'default',
        },
        status: 'completed',
        result,
      });
    }
  }

  /**
   * Record a failure
   */
  recordFailure(agentId: string, error: string): void {
    const agent = this.expectedAgents.get(agentId);
    if (agent) {
      agent.status = 'failed';
      agent.error = error;
    } else {
      this.expectedAgents.set(agentId, {
        config: {
          name: agentId.split('@')[0] || agentId,
          prompt: '',
          systemPromptMode: 'default',
        },
        status: 'failed',
        error,
      });
    }
  }

  /**
   * Record timeout
   */
  recordTimeout(agentId: string, elapsed: number): void {
    const agent = this.expectedAgents.get(agentId);
    if (agent) {
      agent.status = 'timed_out';
    } else {
      this.expectedAgents.set(agentId, {
        config: {
          name: agentId.split('@')[0] || agentId,
          prompt: '',
          systemPromptMode: 'default',
        },
        status: 'timed_out',
        error: `Timed out after ${elapsed}s`,
      });
    }
  }

  /**
   * Record cancellation
   */
  recordCancellation(agentId: string): void {
    const agent = this.expectedAgents.get(agentId);
    if (agent) {
      agent.status = 'cancelled';
    }
  }

  /**
   * Generate aggregated summary
   */
  generateSummary(): AggregatedResult {
    const results: SubAgentResult[] = [];
    let totalDuration = 0;
    let totalTokensUsed = 0;
    let totalToolUses = 0;

    for (const [agentId, agent] of this.expectedAgents.entries()) {
      if (agent.result) {
        results.push(agent.result);
        totalDuration = Math.max(totalDuration, agent.result.duration);
        totalTokensUsed += agent.result.totalTokensUsed;
        totalToolUses += agent.result.toolUseCount;
      } else {
        // Create a minimal result for failed/timeout agents
        const name = agent.config.name || agentId.split('@')[0] || agentId;
        results.push({
          agentId,
          name,
          success: false,
          output: this.formatFailedResult(agent),
          toolUseCount: 0,
          totalTokensUsed: 0,
          duration: 0,
          error: agent.error,
        });
      }
    }

    return {
      results,
      totalDuration,
      totalTokensUsed,
      totalToolUses,
      summary: this.generateNaturalLanguageSummary(results),
    };
  }

  /**
   * Get status of all agents
   */
  getStatus(): Record<string, string> {
    const status: Record<string, string> = {};
    for (const [agentId, agent] of this.expectedAgents.entries()) {
      status[agentId] = agent.status;
    }
    return status;
  }

  /**
   * Check if all agents have completed (success or failure)
   */
  isAllDone(): boolean {
    for (const agent of this.expectedAgents.values()) {
      if (agent.status === 'pending') {
        return false;
      }
    }
    return true;
  }

  /**
   * Reset the aggregator
   */
  reset(): void {
    this.expectedAgents.clear();
    this.startedAt = Date.now();
  }

  /**
   * Format a failed agent's result
   */
  private formatFailedResult(agent: ExpectedAgent): string {
    const name = agent.config.name;
    const task = agent.config.prompt?.slice(0, 100) || 'Unknown task';

    switch (agent.status) {
      case 'failed':
        return `[${name}] (failed)\nTask: ${task}\nError: ${agent.error || 'Unknown error'}`;
      case 'timed_out':
        return `[${name}] (timed_out)\nTask: ${task}\nError: Exceeded time limit`;
      case 'cancelled':
        return `[${name}] (cancelled)\nTask: ${task}\nError: Task was cancelled`;
      default:
        return `[${name}] (pending)\nTask: ${task}\nError: Still running`;
    }
  }

  /**
   * Generate natural language summary for LLM comprehension
   */
  private generateNaturalLanguageSummary(results: SubAgentResult[]): string {
    if (results.length === 0) {
      return 'No sub-agents were spawned.';
    }

    const lines: string[] = ['=== Sub-Agent Results ===', ''];

    for (const result of results) {
      const statusIcon = result.success ? '✓' : '✗';
      const statusText = result.success ? 'completed' : `failed: ${result.error || 'unknown'}`;
      const stats = `${result.toolUseCount} tools, ${result.totalTokensUsed} tokens, ${(result.duration / 1000).toFixed(1)}s`;

      lines.push(`[${result.name}] ${statusIcon} (${statusText}, ${stats})`);
      lines.push(`Task: ${result.output.slice(0, 200)}${result.output.length > 200 ? '...' : ''}`);
      lines.push('');
    }

    // Add aggregate statistics
    const successCount = results.filter((r) => r.success).length;
    lines.push(`=== Summary ===`);
    lines.push(
      `${successCount}/${results.length} sub-agents completed successfully.`
    );

    const totalDuration = Math.max(...results.map((r) => r.duration));
    const totalTokens = results.reduce((sum, r) => sum + r.totalTokensUsed, 0);
    lines.push(
      `Total time: ${(totalDuration / 1000).toFixed(1)}s, Total tokens: ${totalTokens.toLocaleString()}`
    );

    return lines.join('\n');
  }
}
