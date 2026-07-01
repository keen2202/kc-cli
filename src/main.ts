#!/usr/bin/env node

// KC-CLI: Intelligent CLI Agent System
// Main entry point

import chalk from 'chalk';
import { getErrorMessage } from './utils/errors';

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

import { main } from './bootstrap/app';

let currentSpinner: Spinner | null = null;

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

  if (prompt) {
    (async () => {
      try {
        for await (const event of queryEngine.submitMessage(prompt)) {
          emit(event);
        }
      } catch (error) {
        emit({ type: 'error', error: { message: getErrorMessage(error) }, timestamp: Date.now() });
      }
    })();
  } else {
    const readline = await import('readline');
    const rl = readline.createInterface({ input: process.stdin });

    rl.on('line', async (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        for await (const event of queryEngine.submitMessage(trimmed)) {
          emit(event);
        }
      } catch (error) {
        emit({ type: 'error', error: { message: getErrorMessage(error) }, timestamp: Date.now() });
      }
    });
  }
}

// ── Single prompt mode ──

async function executePrompt(queryEngine: QueryEngine, prompt: string) {
  console.log(chalk.bold('\n🤔 Processing your request...\n'));

  try {
    for await (const event of queryEngine.submitMessage(prompt)) {
      handleStreamEvent(event);
    }
  } catch (error) {
    console.error(
      chalk.red(`\n❌ Fatal error: ${getErrorMessage(error)}`)
    );
    process.exit(1);
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

  console.log(chalk.bold('\n💬 Ready! What would you like me to do?\n'));
  console.log(chalk.gray('Type your prompt and press Enter.'));
  console.log(chalk.gray('Type /help for commands, /exit to quit.\n'));

  const cleanup = () => {
    console.log(chalk.yellow('\n👋 Goodbye!'));
    rl.close();
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  const askQuestion = () => {
    rl.question(chalk.cyan.bold('kc> '), async (input) => {
      const trimmed = input.trim();

      if (trimmed.startsWith('/')) {
        await handleCommand(trimmed, queryEngine, rl);
        askQuestion();
        return;
      }

      if (!trimmed) {
        askQuestion();
        return;
      }

      try {
        for await (const event of queryEngine.submitMessage(trimmed)) {
          handleStreamEvent(event);
        }
      } catch (error) {
        console.error(
          chalk.red(`\n❌ Error: ${getErrorMessage(error)}`)
        );
      }

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
  rl: import('readline').Interface
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

    case '/tools':
      const tools = toolRegistry.getAllTools();
      console.log(chalk.bold('\n🔧 Available Tools:'));
      for (const tool of tools) {
        const readOnly = tool.isReadOnly ? chalk.green(' [read-only]') : '';
        console.log(chalk.gray(`  - ${tool.name}${readOnly}`));
      }
      console.log();
      break;

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

    case '/exit':
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

async function listTools() {
  await registerBuiltInTools();
  const tools = toolRegistry.getAllTools();

  console.log(chalk.bold('\n🔧 Available Tools:\n'));

  for (const tool of tools) {
    const readOnly = tool.isReadOnly ? chalk.green('✓') : chalk.red('✗');
    const concurrent = tool.isConcurrencySafe ? chalk.green('✓') : chalk.red('✗');

    console.log(chalk.cyan.bold(`  ${tool.name}`));
    console.log(chalk.gray(`    ${tool.description}`));
    console.log(chalk.gray(`    Read-only: ${readOnly}  |  Concurrency safe: ${concurrent}\n`));
  }
}

// ── Entry ──

main({
  onInteractiveUI: async ({ queryEngine, provider, model, maxTurns }) => {
    const { renderInkUI } = await import('./ui/renderer');
    renderInkUI({ queryEngine, provider, model, maxTurns });
  },
  onRunREPL: runREPL,
  onExecutePrompt: executePrompt,
  onRunJSONMode: runJSONMode,
  onShowConfig: showConfig,
  onListTools: listTools,
}).catch((error) => {
  console.error(chalk.red('Fatal error:'), error);
  process.exit(1);
});
