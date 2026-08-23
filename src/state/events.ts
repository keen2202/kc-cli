// Shared event types - single source of truth for agent and orchestrator events
// Single source of truth for agent and orchestrator event types

import type { ChatMessage, ToolCall, ToolResult, PlanningFinding } from '../query/protocol';
import type { BudgetSnapshot } from '../services/budget';
import type { AcceptanceReport } from '../query/completion-report';

/**
 * Token usage tracking
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/**
 * Sub-agent result
 */
export interface SubAgentResult {
  agentId: string;
  name: string;
  success: boolean;
  output: string;
  toolUseCount: number;
  totalTokensUsed: number;
  duration: number;
  error?: string;
}

// T18/M4: AgentEvent and MultiAgentEvent moved to ./protocol.ts (the single
// protocol home for state-machine contracts). Re-exported here for one version
// period — new code should import them from './protocol'.
export type { AgentEvent, MultiAgentEvent } from './protocol';

