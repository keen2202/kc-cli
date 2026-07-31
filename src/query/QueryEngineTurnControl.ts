// Post-streaming turn orchestration, extracted from QueryEngine
// (architecture 4e): progress tracking, importance tagging, phase steers,
// progress checkpoints, periodic git auto-commit, anti-abandonment and
// turn-budget extension. Pure move — event semantics preserved.

import { logger } from '../services/logger';
import { autoCommitAll } from '../utils/git';
import type { AgentEvent } from '../state/types';
import type { AssistantMessage } from './protocol';
import type { ConversationState } from './QueryEngineState';
import type { FileContentCache } from '../services/cache/FileContentCache';
import type { ImportanceTagger } from './QueryEngineImportance';
import { textDeltaEvent } from './QueryEngineEvents';

/**
 * Progress signals for turn auto-extension, shared between the execution
 * phase (file edits) and this turn controller (tool activity).
 */
export interface ProgressTracker {
  lastModifiedTurn: number;
  lastProgressTurn: number;
}

/** Mutable turn budget: `maxTurns` may grow via auto-extension. */
export interface TurnBudget {
  maxTurns: number;
  readonly maxTurnsCeiling: number;
  readonly autoExtend: boolean;
}

/** Everything the turn controller needs from the engine, passed per call. */
export interface TurnControlDeps {
  conversation: ConversationState;
  fileContentCache: FileContentCache;
  importanceTagger: ImportanceTagger;
  readHistory: Map<string, number>;
  editHistory: Map<string, number>;
  modifiedFiles: Set<string>;
  progress: ProgressTracker;
  /** Conversational-query exemption (greetings/small talk skip the steers). */
  conversational: boolean;
  importanceTagging: boolean;
  autoCommitInterval: number;
  minTurns: number;
  cwd: string;
  steer(message: string): void;
}

/**
 * Run all cross-turn bookkeeping after a streaming turn completes:
 * progress signal, importance tagging, phase reminders, progress checkpoints,
 * periodic auto-commit, anti-abandonment and turn-budget extension.
 */
export async function* afterStreamingTurn(
  deps: TurnControlDeps,
  turnCount: number,
  budget: TurnBudget,
): AsyncGenerator<AgentEvent> {
  // Long-task progress signal for turn auto-extension: a turn that issued
  // tool calls counts as progress even when it modifies no files (e.g.
  // read/research-heavy tasks). File edits update lastModifiedTurn separately
  // (see the execution phase).
  const lastStreamedMsg = deps.conversation.getLastMessage();
  if (
    lastStreamedMsg?.role === 'assistant' &&
    ((lastStreamedMsg as AssistantMessage).toolCalls?.length ?? 0) > 0
  ) {
    deps.progress.lastProgressTurn = turnCount;
  }

  // Area 3: Context Efficiency — tag each turn for smart compaction
  if (deps.importanceTagging) {
    deps.fileContentCache.setTurn(turnCount);
    const allMsgs = deps.conversation.getMessages();
    let lastAssistantMsg: AssistantMessage | undefined;
    for (let i = allMsgs.length - 1; i >= 0; i--) {
      if (allMsgs[i].role === 'assistant') {
        lastAssistantMsg = allMsgs[i] as AssistantMessage;
        break;
      }
    }
    if (lastAssistantMsg) {
      // Collect tool names and outputs from this turn
      const toolNames = (lastAssistantMsg.toolCalls || []).map(tc => tc.toolName);
      const toolOutputs: string[] = [];
      // Scan recent tool messages for outputs
      for (let i = allMsgs.length - 1; i >= 0; i--) {
        const m = allMsgs[i];
        if (m.role === 'tool' && m.toolResults) {
          for (const tr of m.toolResults) {
            if (tr.output) toolOutputs.push(typeof tr.output === 'string' ? tr.output : String(tr.output));
          }
        }
      }

      const tag = deps.importanceTagger.tagTurn(
        lastAssistantMsg,
        toolNames,
        toolOutputs,
        turnCount,
        Array.from(deps.modifiedFiles)
      );
      deps.conversation.tagMessage(lastAssistantMsg.id, tag);

      // Track file read/edit history for duplicate detection
      for (const fp of tag.filePaths) {
        if (toolNames.includes('write') || toolNames.includes('edit')) {
          deps.editHistory.set(fp, turnCount);
          deps.fileContentCache.invalidate(fp);
        } else {
          deps.readHistory.set(fp, turnCount);
        }
      }
    }
  }

  // Phase 1 reminder (first turn) — not for conversational queries,
  // which must answer directly without touring the codebase.
  if (turnCount === 1 && budget.maxTurns > 10 && !deps.conversational) {
    deps.steer(`[Phase 1 - Planning] You are in the planning phase. Focus on reading files and understanding the codebase. Do not make changes yet. Formulate a concrete plan before proceeding to implementation.`);
  }

  // Phase 3 reminder (5 turns before budget exhaustion)
  if (turnCount === budget.maxTurns - 5 && budget.maxTurns > 10 && !deps.conversational) {
    deps.steer(`[Phase 3 - Verification] You are entering the verification phase. Stop making new changes. Run tests to verify your modifications, review all changed files, and fix any remaining issues.`);
  }

  // Periodic progress summary (every 10 turns)
  if (turnCount % 10 === 0 && turnCount > 0 && deps.modifiedFiles.size > 0) {
    const fileList = Array.from(deps.modifiedFiles).map(f => `- ${f}`).join('\n');
    const remaining = budget.maxTurns - turnCount;
    deps.conversation.addMessage({
      id: `checkpoint_${turnCount}_${Date.now()}`,
      role: 'user',
      content: `[Progress Checkpoint - Turn ${turnCount}/${budget.maxTurns}]\nModified files so far:\n${fileList}\n\nRemember these modifications as you continue working. You have ${remaining} turns remaining.`,
      timestamp: Date.now(),
    });
  }

  // P0: Periodic auto-commit (every N turns when there are uncommitted changes)
  if (deps.autoCommitInterval > 0 && turnCount > 0 && turnCount % deps.autoCommitInterval === 0) {
    try {
      const committed = await autoCommitAll(deps.cwd, `kc-cli auto-commit: checkpoint at turn ${turnCount}`);
      if (committed) {
        logger.query.info(`[QueryEngine] Periodic auto-commit at turn ${turnCount}`);
        yield textDeltaEvent(`[Auto-commit checkpoint at turn ${turnCount}]\n`);
      }
    } catch {
      // Non-fatal
    }
  }

  // P1: Anti-abandonment — inject encouragement when agent tries to exit too early
  if (deps.minTurns > 0 && turnCount < deps.minTurns && !deps.conversational) {
    // Check if agent is about to exit (no tool calls in last message)
    const lastMsg = deps.conversation.getLastMessage();
    if (lastMsg && lastMsg.role === 'assistant' && (!(lastMsg as AssistantMessage).toolCalls || (lastMsg as AssistantMessage).toolCalls!.length === 0)) {
      const remaining = deps.minTurns - turnCount;
      deps.steer(`[Anti-Abandonment] You have only completed ${turnCount} turns. You must continue working for at least ${remaining} more turns before you can stop. Keep exploring the codebase and making progress.`);
    }
  }

  if (turnCount >= budget.maxTurns) {
    // Dynamic turn extension: extend when auto-extend is enabled and the
    // agent is actively making progress — either editing files or (for
    // read/research-heavy long tasks) still issuing tool calls.
    const madeRecentFileProgress =
      deps.modifiedFiles.size > 0 && (turnCount - deps.progress.lastModifiedTurn) < 5;
    const madeRecentToolProgress =
      deps.progress.lastProgressTurn > 0 && (turnCount - deps.progress.lastProgressTurn) < 5;
    if (budget.autoExtend && budget.maxTurns < budget.maxTurnsCeiling && (madeRecentFileProgress || madeRecentToolProgress)) {
      budget.maxTurns = Math.min(budget.maxTurns + 20, budget.maxTurnsCeiling);
      logger.query.info(`[QueryEngine] Extended turn budget to ${budget.maxTurns} — active progress detected`);
      yield textDeltaEvent(`\n[Extended turn budget to ${budget.maxTurns} — active progress detected]\n`);
    } else {
      logger.query.warn(`[QueryEngine] Max turns (${budget.maxTurns}) reached, forcing completion`);
      yield textDeltaEvent(`\n[Reached maximum turn limit (${budget.maxTurns}) — stopping]\n`);

      // Auto-commit on turn budget exhaustion (Phase 5.3)
      try {
        const committed = await autoCommitAll(deps.cwd);
        if (committed) {
          logger.query.info('[QueryEngine] Auto-committed changes on turn limit');
          yield textDeltaEvent(`[Auto-committed ${deps.modifiedFiles.size} modified file(s)]\n`);
        }
      } catch {
        // Non-fatal
      }
    }
  }
}
