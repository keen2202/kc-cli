import type { AssistantMessage, PlanningFinding, PlanningPhaseConfig } from './protocol';
import { buildSourcePathRegex } from '../constants';

const PLANNING_SYSTEM_PROMPT = `## PLANNING PHASE

You are in a strategic planning phase. DO NOT edit any files. Your tools for writing/editing code are currently locked.

Your job in this phase:
1. **Run the failing tests** — use bash to execute the test suite. Capture exact error messages and stack traces.
2. **Search for relevant code** — use grep/glob to locate code referenced in the error messages. Be specific, not broad.
3. **Read targeted code sections** — read only the functions/classes referenced in errors, not entire files.
4. **Form a hypothesis** — identify the root cause and what changes are needed to fix it.
5. **Signal completion** — when you have a concrete plan, describe it clearly. The system will detect completion and unlock editing tools.

Time is limited — this phase has a strict turn budget. Be efficient.`;

const PLANNING_COMPLETE_PATTERNS = [
  /\bplan complete\b/i,
  /\bhere is my plan\b/i,
  /\bmy hypothesis is\b/i,
  /\bi will (fix|change|modify|update|add|remove)\b/i,
  /\bready to implement\b/i,
  /\bproceed(?:ing)? (?:to|with) (?:implementation|editing|the fix)\b/i,
];

const BLOCKED_TOOLS = new Set(['write', 'edit', 'git_commit']);

export class PlanningPhaseHandler {
  private config: PlanningPhaseConfig;
  private turnCount = 0;
  private findings: PlanningFinding[] = [];

  constructor(config?: Partial<PlanningPhaseConfig>) {
    this.config = {
      enabled: config?.enabled ?? true,
      maxTurns: config?.maxTurns ?? 3,
      exemptFromBudget: config?.exemptFromBudget ?? true,
    };
  }

  get isEnabled(): boolean {
    return this.config.enabled;
  }

  get isExemptFromBudget(): boolean {
    return this.config.exemptFromBudget;
  }

  get currentTurn(): number {
    return this.turnCount;
  }

  get maxTurns(): number {
    return this.config.maxTurns;
  }

  /** Get the planning-phase guard system prompt. */
  getSystemPrompt(): string {
    return PLANNING_SYSTEM_PROMPT;
  }

  /** Check if a tool is allowed during planning phase. */
  isToolAllowed(toolName: string): boolean {
    if (BLOCKED_TOOLS.has(toolName)) return false;
    return true;
  }

  /** Get the denial message when a blocked tool is invoked. */
  getBlockedToolMessage(toolName: string): string {
    return `Tool "${toolName}" is locked during the planning phase. Complete your plan first by understanding the problem, locating relevant code, and forming a hypothesis. Use grep/glob/read/bash instead.`;
  }

  /** Record a planning turn. Returns true if planning should continue. */
  recordTurn(): boolean {
    this.turnCount++;
    return this.turnCount < this.config.maxTurns;
  }

  /** Evaluate if the agent has signaled planning is complete. */
  evaluateComplete(lastMessage: AssistantMessage): boolean {
    const content = lastMessage.content || '';
    // Also check tool call intent — if agent tried to use edit/write, they're ready
    const triedEdit = lastMessage.toolCalls?.some(
      tc => BLOCKED_TOOLS.has(tc.toolName)
    );
    if (triedEdit) return true;

    for (const pattern of PLANNING_COMPLETE_PATTERNS) {
      if (pattern.test(content)) return true;
    }
    return false;
  }

  /** Extract structured findings from the planning phase messages. */
  extractFindings(planningMessages: AssistantMessage[]): PlanningFinding[] {
    for (const msg of planningMessages) {
      const content = msg.content || '';
      const hypothesisMatch = content.match(
        /(?:hypothesis|plan|root cause|the (?:bug|issue|problem) is)[:\s]+(.+?)(?:\n|$)/i
      );
      const fileMatches = content.match(buildSourcePathRegex());
      const errorMatch = content.match(
        /(?:Error|AssertionError|FAILED)[:\s]+(.+?)(?:\n|$)/i
      );

      if (hypothesisMatch || (fileMatches && fileMatches.length > 0)) {
        this.findings.push({
          hypothesis: hypothesisMatch?.[1]?.trim() || content.slice(0, 200),
          relevantFiles: [...new Set(fileMatches || [])],
          testErrorSummary: errorMatch?.[1]?.trim(),
          confidence: hypothesisMatch ? 'medium' : 'low',
        });
      }
    }

    return this.findings;
  }

  /** Get all accumulated findings. */
  getFindings(): PlanningFinding[] {
    return this.findings;
  }

  /** Reset for a new session. */
  reset(): void {
    this.turnCount = 0;
    this.findings = [];
  }
}
