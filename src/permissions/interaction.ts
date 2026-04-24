// Permission interaction handler
// Handles user prompts for permission decisions

import chalk from 'chalk';
import type { PermissionResult } from '../types/permissions';
import type { ToolCall } from '../types/message';
import * as readline from 'readline';

export interface PermissionHandlerOptions {
  /** Auto-approve read-only operations */
  autoReadOnly?: boolean;
  /** Timeout for user input (ms), 0 = no timeout */
  timeout?: number;
  /** Log permission decisions */
  verbose?: boolean;
}

/**
 * Interactive permission handler
 * Prompts user for permission decisions when needed
 */
export class PermissionHandler {
  private rl: readline.Interface;
  private options: Required<PermissionHandlerOptions>;
  private decisionLog: Array<{ tool: string; decision: string; timestamp: number }> = [];

  constructor(options: PermissionHandlerOptions = {}) {
    this.options = {
      autoReadOnly: options.autoReadOnly ?? true,
      timeout: options.timeout ?? 0,
      verbose: options.verbose ?? false,
    };

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  }

  /**
   * Handle permission request
   * Returns resolved permission result
   */
  async handlePermission(
    toolCall: ToolCall,
    permissionResult: PermissionResult
  ): Promise<PermissionResult> {
    const { behavior, message } = permissionResult;

    // Log if verbose
    if (this.options.verbose) {
      console.log(chalk.gray(`[Permission] ${toolCall.toolName}: ${behavior} - ${message}`));
    }

    // Already allowed or passthrough
    if (behavior === 'allow') {
      return permissionResult;
    }

    // Denied - cannot proceed
    if (behavior === 'deny') {
      this.logDecision(toolCall.toolName, 'denied');
      return permissionResult;
    }

    // Ask user
    if (behavior === 'ask') {
      return this.askUser(toolCall, message);
    }

    // Default: allow (safe fallback)
    return permissionResult;
  }

  /**
   * Ask user for permission
   */
  private async askUser(
    toolCall: ToolCall,
    message: string
  ): Promise<PermissionResult> {
    // Format prompt
    const prompt = this.formatPrompt(toolCall, message);
    console.log(chalk.yellow(`\n🔒 ${prompt}`));

    // Show tool input details
    const inputSummary = this.formatInputSummary(toolCall.input);
    if (inputSummary) {
      console.log(chalk.gray(`   Details: ${inputSummary}`));
    }

    // Ask user
    const answer = await this.askQuestion('Allow? (y/n/always/always-deny): ');

    this.logDecision(toolCall.toolName, answer);

    switch (answer.toLowerCase()) {
      case 'y':
      case 'yes':
        return {
          behavior: 'allow',
          updatedInput: toolCall.input,
          decisionReason: {
            type: 'user_approved',
            reason: 'User explicitly allowed',
          },
        };

      case 'n':
      case 'no':
        return {
          behavior: 'deny',
          message: 'User denied permission',
          decisionReason: {
            type: 'user_denied',
            reason: 'User explicitly denied',
          },
        };

      case 'always':
        return {
          behavior: 'allow',
          updatedInput: toolCall.input,
          decisionReason: {
            type: 'user_always_allow',
            reason: 'User chose to always allow this operation',
          },
        };

      case 'always-deny':
        return {
          behavior: 'deny',
          message: 'User chose to always deny this operation',
          decisionReason: {
            type: 'user_always_deny',
            reason: 'User chose to always deny this operation',
          },
        };

      default:
        // Default to deny on unclear answer
        return {
          behavior: 'deny',
          message: 'Permission denied (unclear answer)',
          decisionReason: {
            type: 'user_unclear',
            reason: 'User did not explicitly allow',
          },
        };
    }
  }

  /**
   * Format permission prompt
   */
  private formatPrompt(toolCall: ToolCall, message: string): string {
    const toolName = toolCall.toolName;

    // Tool-specific prompts
    switch (toolName) {
      case 'Bash':
        return `Execute command: ${(toolCall.input.command as string) || 'unknown'}`;

      case 'FileRead':
        return `Read file: ${(toolCall.input.path as string) || 'unknown'}`;

      case 'FileWrite':
        return `Write file: ${(toolCall.input.path as string) || 'unknown'}`;

      case 'FileEdit':
        return `Edit file: ${(toolCall.input.path as string) || 'unknown'}`;

      case 'Agent':
        return `Spawn sub-agent: ${(toolCall.input.description as string) || (toolCall.input.prompt as string)?.slice(0, 50) || 'unknown'}`;

      default:
        return `${message}`;
    }
  }

  /**
   * Format input summary for display
   */
  private formatInputSummary(input: Record<string, unknown>): string | null {
    if (!input || Object.keys(input).length === 0) {
      return null;
    }

    // Show first few key-value pairs
    const entries = Object.entries(input).slice(0, 3);
    return entries.map(([key, value]) => {
      const strValue = String(value);
      return strValue.length > 100 ? `${key}: ${strValue.slice(0, 100)}...` : `${key}: ${strValue}`;
    }).join(', ');
  }

  /**
   * Ask question with optional timeout
   */
  private askQuestion(question: string): Promise<string> {
    return new Promise((resolve) => {
      const timeout = this.options.timeout;

      if (timeout > 0) {
        const timer = setTimeout(() => {
          console.log(chalk.yellow('\n⏱️  Timeout - defaulting to deny'));
          resolve('no');
          this.rl.close();
        }, timeout);

        this.rl.question(chalk.cyan(`${question} `), (answer) => {
          clearTimeout(timer);
          resolve(answer.trim());
        });
      } else {
        this.rl.question(chalk.cyan(`${question} `), (answer) => {
          resolve(answer.trim());
        });
      }
    });
  }

  /**
   * Log permission decision
   */
  private logDecision(tool: string, decision: string): void {
    this.decisionLog.push({
      tool,
      decision,
      timestamp: Date.now(),
    });

    if (this.options.verbose) {
      console.log(chalk.gray(`[Decision] ${tool} -> ${decision}`));
    }
  }

  /**
   * Get decision log
   */
  getDecisionLog(): Array<{ tool: string; decision: string; timestamp: number }> {
    return [...this.decisionLog];
  }

  /**
   * Clear decision log
   */
  clearDecisionLog(): void {
    this.decisionLog = [];
  }

  /**
   * Close readline interface
   */
  close(): void {
    this.rl.close();
  }
}

/**
 * Quick permission check without interaction
 * Returns true if permission is granted
 */
export function isPermissionGranted(result: PermissionResult): boolean {
  return result.behavior === 'allow';
}

/**
 * Format permission result for display
 */
export function formatPermissionResult(result: PermissionResult): string {
  const icon = result.behavior === 'allow' ? '✅' :
               result.behavior === 'deny' ? '❌' : '❓';

  return `${icon} ${result.behavior}: ${result.message || 'No message'}`;
}
