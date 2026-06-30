// Event type normalization for UI consumption.
// Handles the AgentEvent / StreamEvent discriminated union correctly
// by mapping agent:-prefixed event types to their canonical UI event type.
// This avoids the inline regex hack previously used in App.ts handleEvent.

import type { AgentEvent } from '../state/types.js';
import type { StreamEvent } from '../query/protocol.js';

/**
 * Canonical UI event type — the common denominator after normalization.
 * All agent:-prefixed types are stripped to their base form for UI handling.
 */
export type CanonicalEventType =
  | 'text_delta'
  | 'thinking_delta'
  | 'turn_complete'
  | 'tool_started'
  | 'tool_completed'
  | 'tool_failed'
  | 'subagent_spawned'
  | 'subagent_completed'
  | 'subagent_failed'
  | 'subagent_cancelled'
  | 'subagent_timed_out'
  | 'cache_status'
  | 'steered'
  | 'token_usage'
  | 'error'
  | 'summary_requested'
  | 'summary_response'
  | 'planning_decision'
  | 'patch_guarantee'
  | 'thinking_delta'
  | 'text_delta'
  | 'inter_agent_message'
  | (string & {}); // Allow unrecognized types to pass through

/**
 * Represents a normalized event with common fields accessible regardless of origin.
 */
export interface NormalizedUIEvent {
  type: CanonicalEventType;
  /** The raw original event for accessing type-specific fields */
  raw: AgentEvent | StreamEvent;
}

/** Mapping from agent:-prefixed types to canonical types */
const AGENT_PREFIX_MAP: Record<string, CanonicalEventType> = {
  'agent:text_delta': 'text_delta',
  'agent:thinking_delta': 'thinking_delta',
  'agent:turn_complete': 'turn_complete',
  'agent:tool_started': 'tool_started',
  'agent:tool_completed': 'tool_completed',
  'agent:tool_failed': 'tool_failed',
  'agent:subagent_spawned': 'subagent_spawned',
  'agent:subagent_completed': 'subagent_completed',
  'agent:subagent_failed': 'subagent_failed',
  'agent:subagent_cancelled': 'subagent_cancelled',
  'agent:subagent_timed_out': 'subagent_timed_out',
  'agent:cache_status': 'cache_status',
  'agent:steered': 'steered',
  'agent:token_usage': 'token_usage',
  'agent:error': 'error',
  'agent:summary_requested': 'summary_requested',
  'agent:summary_response': 'summary_response',
  'agent:planning_decision': 'planning_decision',
  'agent:patch_guarantee': 'patch_guarantee',
  'agent:inter_agent_message': 'inter_agent_message',
};

/**
 * Normalize an AgentEvent or StreamEvent to a canonical UI event.
 * Removes the agent: prefix from AgentEvent types so the UI can handle
 * both event sources uniformly without breaking discriminated union narrowing.
 */
export function normalizeUIEvent(event: AgentEvent | StreamEvent): NormalizedUIEvent {
  const canonicalType = AGENT_PREFIX_MAP[event.type] ?? event.type;
  return { type: canonicalType as CanonicalEventType, raw: event };
}

/**
 * Check if an event type is agent:-prefixed.
 */
export function isAgentPrefixed(type: string): boolean {
  return type.startsWith('agent:');
}
