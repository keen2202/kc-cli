#!/usr/bin/env node

// KC-CLI: Intelligent CLI Agent System
// Main entry point

import chalk from 'chalk';
import { getErrorMessage } from './utils/errors';
import {
  EXIT,
  createRunOutcome,
  exitCodeFor,
  isFailureEvent,
  markFailed,
  type RunOutcome,
} from './utils/exit-codes';
import { installGlobalCrashGuards } from './utils/crash-guards';
import { createSerialQueue } from './utils/async-helpers';

import { profileCheckpoint, getProfileReport } from './bootstrap/profiler';
import { getState, updateState } from './bootstrap/state';
import { loadConfig } from './bootstrap/config';
import { toolRegistry, registerBuiltInTools } from './tools';
import { QueryEngine } from './query/QueryEngine';
import type { AgentEvent } from './state/types';
import type { StreamEvent } from './query/protocol';
import type { PermissionMode } from './permissions/protocol';
import { formatToolResult } from './ui';
import { Spinner } from './ui/spinner';
import { handleBranch, handleCheckout, handleHistory } from './commands/branch';
import { UserProfileService } from './services/userProfile';
import type { UserLevel } from './services/userProfile';
import { ReplSessionService } from './services/replSession';

import { main } from './bootstrap/app';

let currentSpinner: Spinner | null = null;

// ── Global crash guards ──
//
// Installed at module scope so they cover EVERY entry path (ink UI, bare REPL,
// --json, single prompt). They used to live inside runREPL(), which meant the
// default interactive path had no fatal-error handling at all: a floating
// promise rejection terminated the process without ever saving the session.
//
// Each entry path registers its own snapshot saver; until one does, the guard
// degrades to a no-op save and still exits non-zero instead of crashing blind.

const crashGuards = installGlobalCrashGuards();

// ── JSON output mode ──

async function runJSONMode(queryEngine: QueryEngine, prompt: string | undefined, pretty: boolean): Promise<void> {
  const stringify = pretty
    ? (e: any) => JSON.stringify(e, null, 2)
    : (e: any) => JSON.stringify(e);

  const sessionId = `json-${Date.now().toString(36)}`;
  let sequence = 0;

  const emit = (event: any) => {
    const msg = {
      type: 'event',
      payload: event,
      sessionId,
      sequence: sequence++,
    };
    process.stdout.write(stringify(msg) + '\n');
  };

  // R3: a denial / agent error / budget stop must change the exit code, not
  // just print something. `process.exitCode` (rather than process.exit) is used
  // so buffered stdout is still flushed before the process ends.
  const outcome = createRunOutcome();

  const runOne = async (text: string): Promise<void> => {
    try {
      for await (const event of queryEngine.submitMessage(text)) {
        if (isFailureEvent(event)) {
          markFailed(outcome, event.type);
        }
        emit(event);
      }
    } catch (error) {
      markFailed(outcome, `submitMessage: ${getErrorMessage(error)}`);
      emit({ type: 'error', error: { message: getErrorMessage(error) }, timestamp: Date.now() });
    }
    process.exitCode = exitCodeFor(outcome);
  };

  if (prompt) {
    await runOne(prompt);
  } else {
    const readline = await import('readline');
    const rl = readline.createInterface({ input: process.stdin });

    // One line at a time. The 'line' callback fires as fast as stdin produces
    // data, so awaiting inline let a second query run concurrently with the
    // first — interleaving two conversations on a single QueryEngine, mixing up
    // their events and emitting duplicate `sequence` values.
    const queue = createSerialQueue();

    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      void queue.push(() => runOne(trimmed));
    });
  }
}

// ── Single prompt mode ──

async function executePrompt(queryEngine: QueryEngine, prompt: string) {
  console.log(chalk.bold('\n🤔 Processing your request...\n'));

  // R3: permission denials / agent errors used to leave the exit code at 0.
  const outcome = createRunOutcome();

  try {
    for await (const event of queryEngine.submitMessage(prompt)) {
      if (isFailureEvent(event)) {
        markFailed(outcome, event.type);
      }
      handleStreamEvent(event);
    }
  } catch (error) {
    markFailed(outcome, `submitMessage: ${getErrorMessage(error)}`);
    console.error(
      chalk.red(`\n❌ Fatal error: ${getErrorMessage(error)}`)
    );
    process.exit(EXIT.FAILURE);
  }

  if (outcome.failed) {
    process.exit(EXIT.FAILURE);
  }
}

// ── Stream event handler (CLI mode) ──

function handleStreamEvent(event: AgentEvent | StreamEvent): void {
  if (event.type.startsWith('agent:')) {
    switch (event.type) {
      case 'agent:text_delta':
        process.stdout.write(event.text);
        break;

      case 'agent:turn_complete':
        break;

      case 'agent:tool_started': {
        currentSpinner = new Spinner();
        currentSpinner.start(`${event.toolCall.toolName}`);
        break;
      }

      case 'agent:tool_completed': {
        if (currentSpinner) {
          currentSpinner.stop(formatToolResult(event.result.output, false));
          currentSpinner = null;
        } else {
          console.log(formatToolResult(event.result.output, false));
        }
        break;
      }

      case 'agent:tool_failed': {
        if (currentSpinner) {
          currentSpinner.fail(formatToolResult(event.error.message, true));
          currentSpinner = null;
        } else {
          console.log(formatToolResult(event.error.message, true));
        }
        break;
      }

      case 'agent:tool_permission_denied':
        console.log(chalk.red(`\nTool permission denied: ${event.reason}`));
        break;

      case 'agent:compact_micro':
        if (getState().verbose) {
          console.log(chalk.gray(`\nMicrocompacted ~${event.tokensSaved} tokens`));
        }
        break;

      case 'agent:compact_full':
        if (getState().verbose) {
          console.log(chalk.gray(`\nFull compact: ${event.originalTokens} → ${event.compactedTokens} tokens`));
        }
        break;

      case 'agent:error':
        console.error(chalk.red(`\nError: ${event.error.message}`));
        break;

      case 'agent:tool_hint':
        console.log(chalk.cyan(`  💡 ${event.hint}`));
        break;

      case 'agent:complete':
        console.log();
        break;
    }
  } else {
    switch (event.type) {
      case 'text_delta':
        process.stdout.write(event.text);
        break;

      case 'tool_use_start': {
        currentSpinner = new Spinner();
        currentSpinner.start(`${event.toolCall.toolName}`);
        break;
      }

      case 'tool_use_end': {
        if (currentSpinner) {
          if (event.result.isError) {
            currentSpinner.fail(formatToolResult(event.result.output, true));
          } else {
            currentSpinner.stop(formatToolResult(event.result.output, false));
          }
          currentSpinner = null;
        } else {
          console.log(formatToolResult(event.result.output, event.result.isError));
        }
        break;
      }

      case 'error':
        console.error(chalk.red(`\nError: ${event.error.message}`));
        break;

      case 'complete':
        console.log();
        break;
    }
  }
}

// ── Fallback REPL (bare mode or non-TTY) ──

async function runREPL(queryEngine: QueryEngine) {
  const readline = await import('readline');

  const rl: import('readline').Interface = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // Session persistence parity with the ink UI: snapshot after each completed
  // turn so an interrupted REPL session can be resumed via /session.
  const replSession = new ReplSessionService();

  console.log(chalk.bold('\n💬 Ready! What would you like me to do?\n'));
  console.log(chalk.gray('Type your prompt and press Enter.'));
  console.log(chalk.gray('Type /help for commands, /exit to quit.\n'));

  const cleanup = () => {
    console.log(chalk.yellow('\n👋 Goodbye!'));
    rl.close();
    // O5: if persistence kept failing this session, say so loudly — the user
    // should not walk away believing hours of conversation were saved.
    if (replSession.getSaveFailureCount() > 0) {
      console.log(
        chalk.red(
          `⚠️  WARNING: ${replSession.getSaveFailureCount()} session save attempt(s) FAILED this session — the conversation was NOT reliably persisted.`,
        ),
      );
    }
    // Best-effort final snapshot before exiting (save() never throws, but the
    // catch guard keeps `.finally` from absorbing an unexpected rejection).
    void replSession
      .save(queryEngine)
      .catch(() => {})
      .finally(() => process.exit(0));
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  // The process-wide fatal handlers live at module scope (installGlobalCrashGuards).
  // Point them at this REPL's session service so a crash still flushes the
  // conversation (save() never throws, so the handler cannot crash-loop).
  crashGuards.setSnapshotSaver(async () => {
    await replSession.save(queryEngine);
  });

  const askQuestion = () => {
    rl.question(chalk.cyan.bold('kc> '), async (input) => {
      const trimmed = input.trim();

      if (trimmed.startsWith('/')) {
        await handleCommand(trimmed, queryEngine, rl, replSession);
        askQuestion();
        return;
      }

      if (!trimmed) {
        askQuestion();
        return;
      }

      try {
        replSession.bumpTurn();
        for await (const event of queryEngine.submitMessage(trimmed)) {
          replSession.noteEvent(event);
          // Narrow the crash-loss window inside a long multi-turn query:
          // throttled snapshot after each completed agent turn.
          if (event.type === 'agent:turn_complete') {
            void replSession.saveThrottled(queryEngine).catch(() => {});
          }
          handleStreamEvent(event);
        }
      } catch (error) {
        console.error(
          chalk.red(`\n❌ Error: ${getErrorMessage(error)}`)
        );
      }

      // Persist the conversation after every turn (best-effort).
      await replSession.save(queryEngine);

      console.log();
      askQuestion();
    });
  };

  askQuestion();
}

// ── REPL command handler ──

async function handleCommand(
  command: string,
  queryEngine: QueryEngine,
  rl: import('readline').Interface,
  replSession: ReplSessionService
) {
  const parts = command.split(' ');
  const cmd = parts[0]!.toLowerCase();

  switch (cmd) {
    case '/help':
      console.log(chalk.bold('\n📖 Available Commands:'));
      console.log(chalk.gray('  /help          - Show this help'));
      console.log(chalk.gray('  /key <api-key> - Set API key at runtime'));
      console.log(chalk.gray('  /clear         - Clear conversation'));
      console.log(chalk.gray('  /mode <mode>   - Set permission mode'));
      console.log(chalk.gray('  /tools         - List available tools'));
      console.log(chalk.gray('  /level [level] - Show/set user level (beginner|intermediate|advanced)'));
      console.log(chalk.gray('  /status        - Show current status'));
      console.log(chalk.gray('  /session [sub] - List (default), load <id>, or start a new session'));
      console.log(chalk.gray('  /branch [name] - List or create branches'));
      console.log(chalk.gray('  /checkout <id> - Switch to a branch'));
      console.log(chalk.gray('  /history       - Show conversation tree'));
      console.log(chalk.gray('  /exit          - Exit\n'));
      break;

    case '/clear':
      queryEngine.clear();
      console.log(chalk.green('✓ Conversation cleared\n'));
      break;

    case '/mode':
      const mode = parts[1];
      if (mode) {
        updateState({ permissionMode: mode as PermissionMode });
        console.log(chalk.green(`✓ Permission mode set to: ${mode}\n`));
      } else {
        console.log(chalk.yellow(`Current mode: ${getState().permissionMode}\n`));
      }
      break;

    case '/key': {
      const key = parts[1];
      if (key) {
        const validationError = queryEngine.setApiKey(key);
        if (validationError) {
          console.log(chalk.red(`✗ Invalid API key: ${validationError}\n`));
        } else {
          console.log(chalk.green('✓ API key updated.\n'));
        }
      } else {
        console.log(chalk.yellow('Usage: /key <api-key>\n'));
      }
      break;
    }

    case '/tools': {
      // Load lazily-registered tools so the full set is listed, not just eager ones.
      await toolRegistry.preloadAllTools();
      const tools = toolRegistry.getAllTools();
      console.log(chalk.bold('\n🔧 Available Tools:'));
      for (const tool of tools) {
        const readOnly = evalToolFlag(tool.isReadOnly, false) ? chalk.green(' [read-only]') : '';
        console.log(chalk.gray(`  - ${tool.name}${readOnly}`));
      }
      console.log();
      break;
    }

    case '/status': {
      const state = getState();
      const profileService = new UserProfileService();
      await profileService.load();
      console.log(chalk.bold('\n📊 Status:'));
      console.log(chalk.gray(`  CWD: ${state.cwd}`));
      console.log(chalk.gray(`  Mode: ${state.permissionMode}`));
      console.log(chalk.gray(`  Level: ${profileService.getLevel()}`));
      console.log(chalk.gray(`  Session: ${state.sessionId}`));
      console.log();
      break;
    }

    case '/session': {
      const sub = (parts[1] || 'list').trim();
      if (sub === 'list') {
        const sessions = await replSession.list(10);
        if (sessions.length === 0) {
          console.log(chalk.gray('No saved sessions yet.\n'));
        } else {
          console.log(chalk.bold('\n💾 Recent sessions:'));
          for (const s of sessions) {
            const when = new Date(s.metadata.lastModified).toLocaleString();
            console.log(chalk.gray(`  ${s.sessionId}  ·  ${when}  ·  ${s.messages.length} msg(s)`));
          }
          console.log(chalk.gray('\nUse /session <id> to load, or /session new to start fresh.\n'));
        }
      } else if (sub === 'new') {
        const newId = replSession.startNew(queryEngine);
        console.log(chalk.green(`✓ Started new session: ${newId}\n`));
      } else {
        try {
          const loaded = await replSession.load(queryEngine, sub);
          if (!loaded) {
            console.log(chalk.yellow(`Session not found: ${sub}\n`));
          } else {
            console.log(chalk.green(`✓ Loaded session: ${sub} (${loaded.messages.length} message(s))\n`));
          }
        } catch (err) {
          console.log(chalk.red(`✗ Failed to restore session: ${getErrorMessage(err)}. Current session unchanged.\n`));
        }
      }
      break;
    }

    case '/exit':
      // Persist the conversation before quitting so it can be resumed.
      await replSession.save(queryEngine);
      console.log(chalk.yellow('\n👋 Goodbye!'));
      rl.close();
      process.exit(0);
      break;

    case '/branch':
      handleBranch(queryEngine, parts[1]);
      break;

    case '/checkout':
      if (parts[1]) {
        handleCheckout(queryEngine, parts[1]);
      } else {
        console.log(chalk.yellow('Usage: /checkout <branch-id>\n'));
      }
      break;

    case '/history':
      handleHistory(queryEngine);
      break;

    case '/level': {
      const profileService = new UserProfileService();
      await profileService.load();
      const levelArg = parts[1];
      if (levelArg && (levelArg === 'beginner' || levelArg === 'intermediate' || levelArg === 'advanced')) {
        profileService.updateLevel(levelArg as UserLevel);
        await profileService.persist();
        console.log(chalk.green(`✓ Level set to: ${levelArg}\n`));
      } else {
        const current = profileService.getLevel();
        console.log(chalk.gray(`Current level: ${current}\n`));
        console.log(chalk.gray('Usage: /level beginner|intermediate|advanced\n'));
      }
      break;
    }

    default:
      console.log(chalk.yellow(`Unknown command: ${cmd}. Type /help for available commands.\n`));
  }
}

// ── Subcommand: show config ──

async function showConfig() {
  const { config, layers } = await loadConfig(process.cwd());
  console.log(chalk.bold('\n⚙️  Configuration:\n'));

  console.log(chalk.bold('API:'));
  console.log(chalk.gray(`  Provider: ${config.provider}`));
  console.log(chalk.gray(`  Model: ${config.model}`));
  console.log(chalk.gray(`  API Key: ${config.apiKey ? '✓ Set' : '✗ Not set'}`));
  console.log(chalk.gray(`  Base URL: ${config.apiBaseUrl || 'default'}`));

  console.log(chalk.bold('\nPermissions:'));
  console.log(chalk.gray(`  Mode: ${config.permissionMode}`));
  console.log(chalk.gray(`  Allow rules: ${config.permissions.allow.length}`));
  console.log(chalk.gray(`  Deny rules: ${config.permissions.deny.length}`));

  console.log(chalk.bold('\nConfig Sources:'));
  for (const layer of layers) {
    console.log(chalk.gray(`  - ${layer.source}`));
  }
  console.log();
}

// ── Subcommand: list tools ──

/**
 * Safely evaluate an input-dependent tool predicate (isReadOnly / isConcurrencySafe)
 * for display. These are functions that may inspect the tool input, so we probe with
 * empty input and fall back if evaluation throws (e.g. reading `input.command`).
 * NOTE: the previous code tested the function reference for truthiness, which is
 * always true — every tool wrongly showed "read-only". This evaluates the predicate.
 */
function evalToolFlag(fn: ((input: any) => boolean) | undefined, fallback: boolean): boolean {
  if (typeof fn !== 'function') return fallback;
  try {
    return fn({}) === true;
  } catch {
    return fallback;
  }
}

async function listTools() {
  await registerBuiltInTools();
  // Load lazily-registered tools (Sql, Docker, Config, Agent, LSP, …) so the full
  // tool set is listed, not just the eagerly-registered ones.
  await toolRegistry.preloadAllTools();
  const tools = toolRegistry.getAllTools();

  console.log(chalk.bold('\n🔧 Available Tools:\n'));

  for (const tool of tools) {
    const readOnly = evalToolFlag(tool.isReadOnly, false) ? chalk.green('✓') : chalk.red('✗');
    const concurrent = evalToolFlag(tool.isConcurrencySafe, true) ? chalk.green('✓') : chalk.red('✗');

    console.log(chalk.cyan.bold(`  ${tool.name}`));
    console.log(chalk.gray(`    ${tool.description}`));
    console.log(chalk.gray(`    Read-only: ${readOnly}  |  Concurrency safe: ${concurrent}\n`));
  }
}

// ── Entry ──

/**
 * Point the process-wide crash guard at a session service for the given engine.
 * The ink UI and the JSON/prompt paths each own their engine, so each registers
 * its own emergency snapshot rather than relying on the REPL's.
 */
function registerCrashSnapshot(queryEngine: QueryEngine): void {
  const session = new ReplSessionService();
  crashGuards.setSnapshotSaver(async () => {
    await session.save(queryEngine);
  });
}

main({
  onInteractiveUI: async ({ queryEngine, provider, model, maxTurns }) => {
    registerCrashSnapshot(queryEngine);
    const { renderInkUI } = await import('./ui/renderer');
    renderInkUI({ queryEngine, provider, model, maxTurns });
  },
  onRunREPL: runREPL,
  onExecutePrompt: (queryEngine, prompt) => {
    registerCrashSnapshot(queryEngine);
    return executePrompt(queryEngine, prompt);
  },
  onRunJSONMode: (queryEngine, prompt, pretty) => {
    registerCrashSnapshot(queryEngine);
    return runJSONMode(queryEngine, prompt, pretty);
  },
  onShowConfig: showConfig,
  onListTools: listTools,
}).catch((error) => {
  console.error(chalk.red('Fatal error:'), error);
  process.exit(EXIT.FAILURE);
});
