// State Validator Service
// Validates conversation state integrity and repairs corruption issues.

import type { ChatMessage, ToolCall, ToolResult } from '../types/message';

export type IssueType =
  | 'orphaned_tool_result'
  | 'missing_tool_call'
  | 'stale_token_estimate'
  | 'invalid_tool_result'
  | 'empty_content';

export type IssueSeverity = 'warning' | 'error';

export interface ValidationIssue {
  type: IssueType;
  messageIndex: number;
  severity: IssueSeverity;
  detail: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  repaired: boolean;
}

/**
 * Validates conversation message integrity and repairs corruption issues.
 */
export class StateValidator {
  /**
   * Validate a message array for integrity issues.
   * Checks for orphaned tool results, missing tool calls, invalid structures.
   */
  validate(messages: ChatMessage[]): ValidationResult {
    const issues: ValidationIssue[] = [];

    // Collect all tool call IDs from assistant messages
    const toolCallIds = new Set<string>();
    for (const msg of messages) {
      if (msg.role === 'assistant' && msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          if (tc.id) {
            toolCallIds.add(tc.id);
          }
        }
      }
    }

    // Check each message for issues
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];

      // Check tool messages for orphaned results
      if (msg.role === 'tool' && msg.toolResults) {
        for (const result of msg.toolResults) {
          if (result.toolCallId && !toolCallIds.has(result.toolCallId)) {
            issues.push({
              type: 'orphaned_tool_result',
              messageIndex: i,
              severity: 'warning',
              detail: `Tool result references unknown tool call: ${result.toolCallId}`,
            });
          }

          // Validate tool result structure
          if (!result.toolCallId || result.toolCallId === '') {
            issues.push({
              type: 'invalid_tool_result',
              messageIndex: i,
              severity: 'error',
              detail: 'Tool result has empty or missing toolCallId',
            });
          }
        }
      }

      // Check assistant messages with tool calls for valid structure
      if (msg.role === 'assistant' && msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          if (!tc.id || tc.id === '') {
            issues.push({
              type: 'invalid_tool_result',
              messageIndex: i,
              severity: 'error',
              detail: `Tool call in assistant message has empty id (tool: ${tc.toolName})`,
            });
          }

          // Check if there's a corresponding tool result (except for the last assistant message)
          if (tc.id && i < messages.length - 1) {
            const hasResult = messages.some(
              (m, idx) => idx > i && m.role === 'tool' && m.toolResults?.some(r => r.toolCallId === tc.id)
            );
            if (!hasResult) {
              issues.push({
                type: 'missing_tool_call',
                messageIndex: i,
                severity: 'warning',
                detail: `Tool call ${tc.id} (${tc.toolName}) has no corresponding result`,
              });
            }
          }
        }
      }
    }

    return {
      valid: issues.filter(i => i.severity === 'error').length === 0,
      issues,
      repaired: false,
    };
  }

  /**
   * Repair validation issues in the message array.
   * Returns the repaired messages array.
   */
  repair(messages: ChatMessage[], issues: ValidationIssue[]): ChatMessage[] {
    if (issues.length === 0) {
      return messages;
    }

    const repaired = [...messages];
    const indicesToRemove = new Set<number>();

    for (const issue of issues) {
      switch (issue.type) {
        case 'orphaned_tool_result':
          // Remove orphaned tool results from the message
          this.removeOrphanedResults(repaired, issue);
          break;

        case 'invalid_tool_result':
          // Mark message index for removal if it has invalid structure
          if (issue.severity === 'error') {
            const msg = repaired[issue.messageIndex];
            if (msg?.role === 'tool' && msg.toolResults) {
              // Filter out invalid results
              const validResults = msg.toolResults.filter(
                r => r.toolCallId && r.toolCallId !== ''
              );
              if (validResults.length === 0) {
                indicesToRemove.add(issue.messageIndex);
              } else {
                (repaired[issue.messageIndex] as any).toolResults = validResults;
              }
            }
          }
          break;

        case 'missing_tool_call':
          // Can't repair missing tool calls — just log
          break;

        case 'stale_token_estimate':
          // Token estimate repair is handled externally
          break;

        case 'empty_content':
          // Not repairable at this level
          break;
      }
    }

    // Remove messages marked for deletion (in reverse order to preserve indices)
    const sortedIndices = Array.from(indicesToRemove).sort((a, b) => b - a);
    for (const idx of sortedIndices) {
      repaired.splice(idx, 1);
    }

    return repaired;
  }

  /**
   * Remove orphaned tool results from a tool message.
   */
  private removeOrphanedResults(messages: ChatMessage[], issue: ValidationIssue): void {
    const msg = messages[issue.messageIndex];
    if (msg?.role === 'tool' && msg.toolResults) {
      // Extract the orphaned toolCallId from the detail message
      const match = issue.detail.match(/unknown tool call: (.+)$/);
      if (match) {
        const orphanedId = match[1];
        const filtered = msg.toolResults.filter(r => r.toolCallId !== orphanedId);
        if (filtered.length === 0) {
          // If all results are orphaned, the whole message is invalid
          // But we don't remove it here — that's handled by index removal
        } else {
          (messages[issue.messageIndex] as any).toolResults = filtered;
        }
      }
    }
  }

  /**
   * Quick check if messages need validation (before expensive full validation).
   */
  needsValidation(messages: ChatMessage[]): boolean {
    // Quick checks for common corruption patterns
    for (const msg of messages) {
      if (msg.role === 'tool') {
        if (!msg.toolResults || msg.toolResults.length === 0) {
          return true;
        }
        for (const r of msg.toolResults) {
          if (!r.toolCallId || r.toolCallId === '') {
            return true;
          }
        }
      }
    }
    return false;
  }
}
