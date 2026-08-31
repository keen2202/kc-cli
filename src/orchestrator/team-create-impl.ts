/**
 * TeamCreate heavy runtime — loaded lazily on first TeamCreate invocation via dynamic import.
 *
 * This module contains everything that pulls in the orchestrator and agent config
 * factory. None of these execute at tool-registration time; they are deferred
 * until the user actually invokes the TeamCreate tool.
 */

import { toolResult, toolError } from '../Tool.js';
import type { ToolResult as ToolResultType } from '../tools/protocol.js';
import type { ToolUseContext } from '../tools/protocol.js';
import type { SubAgentResult } from '../state/events.js';
import { getOrchestrator } from './agent-orchestrator.js';
import { createAgentConfig, listAgentTypes } from './agent-definitions.js';
import type { ToolName } from '../tools/protocol.js';
import type { TeamCreateInput } from './team-create-tool.js';

export async function executeTeamCreate(
  input: TeamCreateInput,
  context: ToolUseContext,
  // Accepted for ToolDefinition.call conformance; TeamCreate execution reports no
  // incremental progress.
  _onProgress?: (progress: unknown) => void,
): Promise<ToolResultType<string>> {
  try {
    const orchestrator = getOrchestrator();
    const agentIds: string[] = [];
    const errors: string[] = [];

    // Spawn all agents
    for (const agentConfig of input.agents) {
      try {
        let spawnConfig;

        if (agentConfig.agent_type) {
          // Use pre-defined agent type
          spawnConfig = createAgentConfig(
            agentConfig.agent_type,
            agentConfig.prompt,
            {
              name: agentConfig.name,
              timeoutSeconds: agentConfig.timeout,
              maxTurns: agentConfig.max_turns,
              tools: agentConfig.tools_allow as ToolName[] | undefined,
              deniedTools: agentConfig.tools_deny as ToolName[] | undefined,
            }
          );

          if (!spawnConfig) {
            errors.push(
              `${agentConfig.name}: Unknown agent type ${agentConfig.agent_type}`
            );
            continue;
          }
        } else {
          // Generic agent
          spawnConfig = {
            name: agentConfig.name,
            prompt: agentConfig.prompt,
            systemPromptMode: 'default' as const,
            timeoutSeconds: agentConfig.timeout,
            maxTurns: agentConfig.max_turns,
            tools: agentConfig.tools_allow as ToolName[] | undefined,
            deniedTools: agentConfig.tools_deny as ToolName[] | undefined,
          };
        }

        const agentId = await orchestrator.spawn(spawnConfig, context);
        agentIds.push(agentId);
      } catch (error) {
        errors.push(
          `${agentConfig.name}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    if (agentIds.length === 0) {
      return toolError(
        `Failed to spawn any agents. Errors:\n${errors.join('\n')}`
      );
    }

    if (!input.wait_for_all) {
      // Return immediately with agent IDs
      const outputLines = [
        `Team created: ${agentIds.length} agent(s) spawned\n`,
        `Agents:`,
        ...agentIds.map((id) => `  - ${id}`),
      ];

      if (errors.length > 0) {
        outputLines.push(`\nErrors (${errors.length}):`);
        errors.forEach((err) => outputLines.push(`  - ${err}`));
      }

      outputLines.push(
        `\nUse Agent tool with background=true to check individual status.`
      );

      return toolResult(outputLines.join('\n'), {
        metadata: {
          agent_ids: agentIds,
          total: agentIds.length,
          errors: errors.length,
          wait_for_all: false,
        },
      });
    }

    // Wait for all agents to complete
    const overallTimeoutMs = (Number.isFinite(input.timeout ?? NaN) ? input.timeout! : 600) * 1000;
    const aggregatedResult = await orchestrator.waitForAll(overallTimeoutMs);

    // Format aggregated result
    const outputLines = [
      `Team execution completed\n`,
      `Agents: ${aggregatedResult.results.length}`,
      `Success: ${aggregatedResult.results.filter((r: SubAgentResult) => r.success).length}`,
      `Failed: ${aggregatedResult.results.filter((r: SubAgentResult) => !r.success).length}`,
      `Total tokens: ${aggregatedResult.totalTokensUsed.toLocaleString()}`,
      `Total time: ${(aggregatedResult.totalDuration / 1000).toFixed(1)}s\n`,
      `=== Individual Results ===\n`,
    ];

    for (const result of aggregatedResult.results) {
      const icon = result.success ? '✓' : '✗';
      outputLines.push(
        `[${result.name}] ${icon} (${result.success ? 'success' : `failed: ${result.error || 'unknown'}`})`
      );
      outputLines.push(
        `  Tools: ${result.toolUseCount}, Tokens: ${result.totalTokensUsed}, Time: ${(result.duration / 1000).toFixed(1)}s`
      );
      outputLines.push(`  Output: ${result.output.slice(0, 150)}...`);
      outputLines.push('');
    }

    outputLines.push(`\n${aggregatedResult.summary}`);

    return toolResult(outputLines.join('\n'), {
      metadata: {
        agent_ids: agentIds,
        total: aggregatedResult.results.length,
        success: aggregatedResult.results.filter((r: SubAgentResult) => r.success).length,
        failed: aggregatedResult.results.filter((r: SubAgentResult) => !r.success).length,
        total_tokens: aggregatedResult.totalTokensUsed,
        total_duration: aggregatedResult.totalDuration,
        wait_for_all: true,
      },
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return toolError(`Team creation failed: ${errorMsg}`);
  }
}
