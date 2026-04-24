// Shared orchestrator types - single source of truth
// Resolves circular import issue between orchestrator/types and state/types

import type { AgentEvent } from '../state/types';

/**
 * Sub-agent result
 */
export interface SubAgentResult {
  agentId: string;
  name: string;
  success: boolean;
  output: string; // Formatted result text
  toolUseCount: number;
  totalTokensUsed: number;
  duration: number; // milliseconds
  error?: string;
}

/**
 * Multi-agent events - discriminated union
 */
export type MultiAgentEvent =
  | {
      type: 'agent:subagent_spawned';
      agentId: string;
      name: string;
      timestamp: number;
    }
  | {
      type: 'agent:subagent_progress';
      agentId: string;
      event: AgentEvent;
      timestamp: number;
    }
  | {
      type: 'agent:subagent_completed';
      agentId: string;
      result: SubAgentResult;
      timestamp: number;
    }
  | {
      type: 'agent:subagent_failed';
      agentId: string;
      error: string;
      timestamp: number;
    }
  | {
      type: 'agent:subagent_timed_out';
      agentId: string;
      elapsed: number;
      timestamp: number;
    }
  | {
      type: 'agent:subagent_cancelled';
      agentId: string;
      timestamp: number;
    };
