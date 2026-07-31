// Backend abstract interface for sub-agent execution

import type { SubAgentSpawnConfig, SubAgentStatus, SubAgentRuntime, SpawnResult, SubAgentMessage } from '../types.js';
import type { ToolUseContext } from '../../tools/protocol.js';

/**
 * SubAgentBackend - Abstract interface for executing sub-agents
 *
 * Implementations can use different execution strategies:
 * - InProcess: Same process with AsyncLocalStorage isolation
 * - Subprocess: Separate child process
 */
export interface SubAgentBackend {
  readonly type: 'in_process' | 'subprocess';

  /**
   * Spawn a new sub-agent
   */
  spawn(
    config: SubAgentSpawnConfig,
    parentContext: ToolUseContext
  ): Promise<SpawnResult>;

  /**
   * Send a message to a running sub-agent
   */
  sendMessage(agentId: string, message: SubAgentMessage): Promise<void>;

  /**
   * Shutdown a sub-agent
   * @param force - If true, immediately abort; if false, wait for current tool to complete
   */
  shutdown(agentId: string, force?: boolean): Promise<boolean>;

  /**
   * Get status of a sub-agent
   */
  getStatus(agentId: string): SubAgentStatus | null;

  /**
   * List all active agent IDs
   */
  listActive(): string[];

  /**
   * Shutdown all sub-agents
   */
  shutdownAll(): Promise<void>;
}
