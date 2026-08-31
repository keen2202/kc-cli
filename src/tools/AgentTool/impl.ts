/**
 * AgentTool heavy runtime — loaded lazily on first Agent invocation via dynamic import.
 *
 * This module contains everything that pulls in the orchestrator, agent config
 * factory, and tool registry. None of these execute at tool-registration time;
 * they are deferred until the user actually invokes the Agent tool.
 */

import { toolResult, toolError } from '../../Tool';
import type { ToolResult as ToolResultType } from '../protocol';
import type { ToolUseContext } from '../protocol';
import type { SubAgentSpawnConfig } from '../../orchestrator/types';
import { getOrchestrator } from '../../orchestrator/agent-orchestrator.js';
import { createAgentConfig, listAgentTypes } from '../../orchestrator/agent-definitions.js';
import { secondsToMs } from '../../utils/timeout';
import type { AgentInput } from './index.js';

export async function executeAgent(
  input: AgentInput,
  context: ToolUseContext,
  // Accepted for ToolDefinition.call conformance; Agent execution reports no
  // incremental progress.
  _onProgress?: (progress: unknown) => void,
): Promise<ToolResultType<string>> {
  try {
    // toolRegistry is imported dynamically inside the function body to keep
    // the ESM cycle safe: src/tools.ts will later statically import this
    // tool's entry, and this impl imports toolRegistry from src/tools.ts.
    // Keeping the access inside the function body (not at module top level)
    // ensures the cycle resolves correctly.
    const { toolRegistry } = await import('../../tools.js');
    const tools = toolRegistry.getAllTools();
    const orchestrator = getOrchestrator(tools);

    let config: SubAgentSpawnConfig;

    if (input.agent_type) {
      const agentConfig = createAgentConfig(input.agent_type, input.prompt, {
        timeoutSeconds: input.timeout,
      });
      if (!agentConfig) {
        return toolError(
          `Unknown agent type: ${input.agent_type}. Available types: ${listAgentTypes().join(', ')}`
        );
      }
      config = agentConfig;
    } else {
      config = {
        name: input.description || `agent-${Date.now()}`,
        prompt: input.prompt,
        systemPromptMode: 'default',
        timeoutSeconds: input.timeout,
      };
    }

    const agentId = await orchestrator.spawn(config, context);

    // If background mode, return immediately with the agent ID
    if (input.background) {
      return toolResult(
        `Sub-agent spawned in background.\nAgent ID: ${agentId}\nTask: ${input.description || input.prompt.slice(0, 100)}`,
        {
          metadata: {
            agent_id: agentId,
            agent_type: input.agent_type || 'general',
            background: true,
            status: 'running',
          },
        }
      );
    }

    // Wait for the sub-agent to complete
    const result = await orchestrator.waitForCompletion(
      agentId,
      secondsToMs(input.timeout, 300_000)
    );

    return toolResult(result.output, {
      metadata: {
        agent_id: agentId,
        agent_type: input.agent_type || 'general',
        success: result.success,
        duration_ms: result.duration,
        tool_use_count: result.toolUseCount,
        total_tokens_used: result.totalTokensUsed,
      },
    });
  } catch (error) {
    return toolError(`Agent spawn failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
