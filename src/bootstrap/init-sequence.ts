import chalk from 'chalk';

import { profileCheckpoint, getProfileReport } from './profiler';
import { QueryEngine } from '../query/QueryEngine';
import { formatBanner } from '../ui';
import { setLogLevel } from '../services/logger';
import { updateStatus } from '../ui/statusline';
import { runWithScopedState } from './state';
import { VERSION } from './cli-config';
import { ReplSessionService } from '../services/replSession';
import { getErrorMessage } from '../utils/errors';
import type { SessionSnapshot } from '../memory/protocol';
import type { ChatMessage } from '../query/protocol';

// Re-export for backward compatibility (moved to Bootstrap.ts)
export { buildSystemPrompt } from './Bootstrap';
import { Bootstrap, buildSystemPrompt } from './Bootstrap';

/** Apply LOG_LEVEL env var at startup. */
export function initLogLevel(): void {
  if (process.env.LOG_LEVEL) {
    const validLevels = ['debug', 'info', 'warn', 'error'] as const;
    const level = process.env.LOG_LEVEL.toLowerCase() as typeof validLevels[number];
    if (validLevels.includes(level)) {
      setLogLevel(level);
    }
  }
}

export interface RunAgentOptions {
  prompt: string | undefined;
  opts: Record<string, any>;
  /** Called to enter the interactive UI (Ink). */
  onInteractiveUI: (deps: {
    queryEngine: QueryEngine;
    provider: string;
    model: string;
    maxTurns: number;
    /** Set when kc --continue/--resume restored a session before dispatch. */
    resumedSession?: ResumedSession;
  }) => void;
  /** Called to run the fallback REPL. */
  onRunREPL: (queryEngine: QueryEngine, resumedSessionId?: string) => Promise<void>;
  /** Called for single-prompt mode. */
  onExecutePrompt: (queryEngine: QueryEngine, prompt: string) => Promise<void>;
  /** Called for JSON output mode. */
  onRunJSONMode: (queryEngine: QueryEngine, prompt: string | undefined, pretty: boolean) => Promise<void>;
}

/** A session restored from disk before the UI/REPL took over. */
export interface ResumedSession {
  sessionId: string;
  messages: ChatMessage[];
  turnCount: number;
}

export async function runAgent(options: RunAgentOptions): Promise<void> {
  const { prompt, opts } = options;

  console.log(formatBanner(VERSION));
  profileCheckpoint('banner');

  // ── Phase 1-4: Delegate composition to Bootstrap ──
  const bootstrap = new Bootstrap({
    cwd: opts.cwd || process.cwd(),
    verbose: opts.verbose || false,
    printMode: opts.print || false,
    bareMode: opts.bare || false,
    permissionMode: opts.bypassPermissions ? 'bypassPermissions' : (opts.mode || 'default'),
    maxTurns: opts.maxTurns ? parseInt(opts.maxTurns) : null,
    maxBudgetUsd: opts.maxBudget ? parseFloat(opts.maxBudget) : null,
    model: opts.model,
    provider: opts.provider,
    autoExtendTurns: opts.autoExtendTurns,
    im: opts.im,
    dangerouslySkipPermissions: opts.dangerouslySkipPermissions || false,
  });

  const result = await bootstrap.compose();

  // Wrap post-compose execution in scoped state so getState() works for all
  // downstream code paths (REPL, interactive UI, single-prompt, JSON mode).
  return runWithScopedState(result.state, async () => {
  const { queryEngine, provider, model, apiKey, apiBaseUrl, config, layers, tools, imBridge, state } = result;
  const maxTurns = state.maxTurns || 80;

  // ── Verbose display (config sources) ──
  if (opts.verbose) {
    console.log(chalk.gray(`\nConfig loaded from ${layers.length} sources:`));
    for (const layer of layers) {
      console.log(chalk.gray(`  - ${layer.source}`));
    }
  }

  // ── Verbose display (tools / provider) ──
  if (opts.verbose) {
    console.log(chalk.gray(`\nLoaded ${tools.length} tools:`));
    for (const tool of tools) {
      // isReadOnly is an input-dependent predicate function, not a boolean.
      // Probe it with empty input and fall back to false if it throws.
      let isReadOnly = false;
      try {
        isReadOnly = tool.isReadOnly?.({} as any) === true;
      } catch {
        isReadOnly = false;
      }
      const readOnly = isReadOnly ? '(read-only)' : '';
      console.log(chalk.gray(`  - ${tool.name} ${readOnly}`));
    }
    console.log(chalk.gray(`\nLLM Provider: ${provider}`));
    console.log(chalk.gray(`Model: ${model}`));
    console.log(chalk.gray(`API Key: ${apiKey ? '✓ Set' : '✗ Not set'}`));
  }

  // ── Update status bar ──
  updateStatus({
    provider,
    model,
    maxTurns,
    sessionStartTime: Date.now(),
  });

  // ── Register IM bridge shutdown handlers ──
  if (imBridge) {
    const shutdownIM = async () => {
      await imBridge.shutdownAll();
    };
    process.on('SIGINT', shutdownIM);
    process.on('SIGTERM', shutdownIM);
  }

  // ── Session resume (kc --continue / kc --resume [id]) ──
  // Resolve the target snapshot before dispatch. The REPL restores through its
  // own ReplSessionService (counter re-sync); the UI and non-interactive paths
  // restore at the engine level here.
  let resumeTarget: SessionSnapshot | null = null;
  if (opts.resume || opts.continue) {
    try {
      const replSession = new ReplSessionService();
      const requestedId = typeof opts.resume === 'string' ? opts.resume : undefined;
      if (requestedId) {
        const sessions = await replSession.list(100);
        resumeTarget = sessions.find((s) => s.sessionId === requestedId) ?? null;
        if (!resumeTarget) {
          console.log(chalk.yellow(`No saved session found with id: ${requestedId} — starting fresh.`));
        }
      } else {
        resumeTarget = await replSession.latestForCwd();
        if (!resumeTarget) {
          console.log(chalk.yellow('No saved session found for this directory — starting fresh.'));
        }
      }
    } catch (error) {
      console.log(chalk.yellow(`Session resume failed (${getErrorMessage(error)}) — starting fresh.`));
    }
  }

  // ── Phase 5: Dispatch to REPL / single prompt / JSON mode ──
  if (opts.json || opts.jsonPretty) {
    if (resumeTarget) queryEngine.restoreSession(resumeTarget);
    await options.onRunJSONMode(queryEngine, prompt, opts.jsonPretty);
  } else if (prompt) {
    if (resumeTarget) queryEngine.restoreSession(resumeTarget);
    await options.onExecutePrompt(queryEngine, prompt);
  } else if (!opts.bare && process.stdout.isTTY && process.stdin.isTTY) {
    let resumedSession: ResumedSession | undefined;
    if (resumeTarget) {
      const restoredTurnCount = queryEngine.restoreSession(resumeTarget);
      resumedSession = {
        sessionId: resumeTarget.sessionId,
        messages: resumeTarget.messages,
        turnCount: restoredTurnCount,
      };
    }
    options.onInteractiveUI({
      queryEngine,
      provider,
      model,
      maxTurns,
      resumedSession,
    });
  } else {
    await options.onRunREPL(queryEngine, resumeTarget?.sessionId);
  }

  if (opts.profile) {
    console.log('\n' + getProfileReport());
  }
  }); // runWithScopedState(result.state, ...)
}
