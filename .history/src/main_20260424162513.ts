#!/usr/bin/env node

// CC-CLI: Intelligent CLI Agent System
// Main entry point

import { Command } from 'commander';
import chalk from 'chalk';
import * as path from 'path';

import { profileCheckpoint, getProfileReport } from './bootstrap/profiler';
import { initializeState, getState, updateState } from './bootstrap/state';
import { loadConfig } from './bootstrap/config';
import { toolRegistry, registerBuiltInTools } from './tools';
import { QueryEngine } from './query/QueryEngine';
import type { AgentEvent } from './state/types';
import type { StreamEvent } from './types/message';

const VERSION = '0.1.0';

// ASCII Art Banner
const BANNER = `
${chalk.cyan.bold('╔══════════════════════════════════════╗')}
${chalk.cyan.bold('║')}  ${chalk.yellow.bold('CC-CLI')} - Intelligent Agent System  ${chalk.cyan.bold('║')}
${chalk.cyan.bold('║')}  ${chalk.gray('v' + VERSION)}                             ${chalk.cyan.bold('║')}
${chalk.cyan.bold('╚══════════════════════════════════════╝')}
`;

async function main() {
  profileCheckpoint('start');

  const program = new Command();

  program
    .name('cc')
    .description('CC-CLI - Intelligent CLI Agent System')
    .version(VERSION)
    .argument('[prompt]', 'What would you like me to do?')
    .option('-c, --cwd <directory>', 'Working directory', process.cwd())
    .option('-m, --mode <mode>', 'Permission mode', 'default')
    .option('--model <model>', 'LLM model to use')
    .option('--provider <provider>', 'LLM provider (anthropic/openai/ollama)')
    .option('--max-turns <number>', 'Maximum number of agent turns')
    .option('--max-budget <amount>', 'Maximum budget in USD')
    .option('-v, --verbose', 'Enable verbose output')
    .option('--print', 'Print response and exit (non-interactive)')
    .option('--bare', 'Minimal mode: skip hooks and heavy initialization')
    .option('--bypass-permissions', 'Bypass all permission checks')
    .option('--profile', 'Show startup profile')
    .action(async (prompt: string | undefined, opts: any) => {
      await runAgent(prompt, opts);
    });

  // Additional commands
  program
    .command('config')
    .description('Show current configuration')
    .action(async () => {
      await showConfig();
    });

  program
    .command('tools')
    .description('List available tools')
    .action(async () => {
      await listTools();
    });

  await program.parseAsync(process.argv);
}

async function runAgent(prompt: string | undefined, opts: any) {
  console.log(BANNER);
  profileCheckpoint('banner');

  // Phase 1: Initialize state
  const cwd = path.resolve(opts.cwd || process.cwd());
  initializeState({
    cwd,
    verbose: opts.verbose || false,
    printMode: opts.print || false,
    bareMode: opts.bare || false,
    permissionMode: opts.bypassPermissions ? 'bypassPermissions' : (opts.mode || 'default'),
    maxTurns: opts.maxTurns ? parseInt(opts.maxTurns) : null,
    maxBudgetUsd: opts.maxBudget ? parseFloat(opts.maxBudget) : null,
  });
  profileCheckpoint('state_init');

  // Phase 2: Load configuration
  const { config, layers } = await loadConfig(cwd);

  if (opts.verbose) {
    console.log(chalk.gray(`\nConfig loaded from ${layers.length} sources:`));
    for (const layer of layers) {
      console.log(chalk.gray(`  - ${layer.source}`));
    }
  }

  // Apply config overrides
  const model = opts.model || config.model;
  const provider = opts.provider || config.provider;
  const apiKey = config.apiKey;
  const apiBaseUrl = config.apiBaseUrl;
  profileCheckpoint('config_load');

  // Phase 3: Register tools
  if (!opts.bare) {
    await registerBuiltInTools();
  }
  profileCheckpoint('tools_registered');

  // Phase 4: Create query engine
  const tools = toolRegistry.getAllTools();

  if (opts.verbose) {
    console.log(chalk.gray(`\nLoaded ${tools.length} tools:`));
    for (const tool of tools) {
      const readOnly = tool.isReadOnly ? '(read-only)' : '';
      console.log(chalk.gray(`  - ${tool.name} ${readOnly}`));
    }
    console.log(chalk.gray(`\nLLM Provider: ${provider}`));
    console.log(chalk.gray(`Model: ${model}`));
    console.log(chalk.gray(`API Key: ${apiKey ? '✓ Set' : '✗ Not set'}`));
  }

  const systemPrompt = buildSystemPrompt(tools);

  const queryEngine = new QueryEngine(
    {
      model,
      provider: provider as any,
      apiKey,
      apiBaseUrl,
      maxTurns: getState().maxTurns || 50,
      maxBudgetUsd: getState().maxBudgetUsd,
      systemPrompt,
    },
    tools
  );

  profileCheckpoint('engine_created');

  // Phase 5: Run REPL or single prompt
  if (prompt) {
    // Single prompt mode
    await executePrompt(queryEngine, prompt);
  } else {
    // Interactive REPL mode
    await runREPL(queryEngine);
  }

  if (opts.profile) {
    console.log('\n' + getProfileReport());
  }
}

async function executePrompt(queryEngine: QueryEngine, prompt: string) {
  console.log(chalk.bold('\n🤔 Processing your request...\n'));

  try {
    for await (const event of queryEngine.submitMessage(prompt)) {
      handleStreamEvent(event);
    }
  } catch (error) {
    console.error(
      chalk.red(`\n❌ Fatal error: ${error instanceof Error ? error.message : String(error)}`)
    );
    process.exit(1);
  }
}

/**
 * Unified event handler for both AgentEvent and legacy StreamEvent types
 */
function handleStreamEvent(event: AgentEvent | StreamEvent): void {
  if (event.type.startsWith('agent:')) {
    // Handle AgentEvent types
    switch (event.type) {
      case 'agent:text_delta':
        process.stdout.write(event.text);
        break;

      case 'agent:turn_complete':
        // Turn complete, continue to next phase
        break;

      case 'agent:tool_started':
        console.log(chalk.yellow(`\n\n🔧 Using tool: ${event.toolCall.toolName}`));
        console.log(chalk.gray(`   Input: ${JSON.stringify(event.toolCall.input)}`));
        break;

      case 'agent:tool_completed':
        console.log(chalk.green(`\n✅ Tool completed successfully`));
        if (event.result.output.length < 200) {
          console.log(chalk.gray(`   Output: ${event.result.output}`));
        }
        break;

      case 'agent:tool_failed':
        console.log(chalk.red(`\n❌ Tool failed: ${event.error.message}`));
        break;

      case 'agent:tool_permission_denied':
        console.log(chalk.red(`\n🚫 Tool permission denied: ${event.reason}`));
        break;

      case 'agent:compact_micro':
        if (getState().verbose) {
          console.log(chalk.gray(`\n📦 Microcompacted ~${event.tokensSaved} tokens`));
        }
        break;

      case 'agent:compact_full':
        if (getState().verbose) {
          console.log(chalk.gray(`\n📦 Full compact: ${event.originalTokens} → ${event.compactedTokens} tokens`));
        }
        break;

      case 'agent:error':
        console.error(chalk.red(`\n❌ Error: ${event.error.message}`));
        break;

      case 'agent:complete':
        console.log(); // Newline
        break;
    }
  } else {
    // Handle legacy StreamEvent types (backward compatibility)
    switch (event.type) {
      case 'text_delta':
        process.stdout.write(event.text);
        break;

      case 'tool_use_start':
        console.log(chalk.yellow(`\n\n🔧 Using tool: ${event.toolCall.toolName}`));
        console.log(chalk.gray(`   Input: ${JSON.stringify(event.toolCall.input)}`));
        break;

      case 'tool_use_end':
        if (event.result.isError) {
          console.log(chalk.red(`\n❌ Tool error: ${event.result.output}`));
        } else {
          console.log(chalk.green(`\n✅ Tool completed successfully`));
          if (event.result.output.length < 200) {
            console.log(chalk.gray(`   Output: ${event.result.output}`));
          }
        }
        break;

      case 'error':
        console.error(chalk.red(`\n❌ Error: ${event.error.message}`));
        break;

      case 'complete':
        console.log(); // Newline
        break;
    }
  }
}

async function runREPL(queryEngine: QueryEngine) {
  const readline = await import('readline');

  const rl: import('readline').Interface = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log(chalk.bold('\n💬 Ready! What would you like me to do?\n'));
  console.log(chalk.gray('Type your prompt and press Enter.'));
  console.log(chalk.gray('Type /help for commands, /exit to quit.\n'));

  // Graceful shutdown handler
  const cleanup = () => {
    console.log(chalk.yellow('\n👋 Goodbye!'));
    rl.close();
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  const askQuestion = () => {
    rl.question(chalk.cyan.bold('cc> '), async (input) => {
      const trimmed = input.trim();

      // Handle commands
      if (trimmed.startsWith('/')) {
        await handleCommand(trimmed, queryEngine, rl);
        askQuestion();
        return;
      }

      if (!trimmed) {
        askQuestion();
        return;
      }

      // Execute prompt
      try {
        for await (const event of queryEngine.submitMessage(trimmed)) {
          handleStreamEvent(event);
        }
      } catch (error) {
        console.error(
          chalk.red(`\n❌ Error: ${error instanceof Error ? error.message : String(error)}`)
        );
      }

      console.log(); // Separator
      askQuestion();
    });
  };

  askQuestion();
}

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
      console.log(chalk.gray('  /clear         - Clear conversation'));
      console.log(chalk.gray('  /mode <mode>   - Set permission mode'));
      console.log(chalk.gray('  /tools         - List available tools'));
      console.log(chalk.gray('  /status        - Show current status'));
      console.log(chalk.gray('  /exit          - Exit\n'));
      break;

    case '/clear':
      queryEngine.clear();
      console.log(chalk.green('✓ Conversation cleared\n'));
      break;

    case '/mode':
      const mode = parts[1];
      if (mode) {
        updateState({ permissionMode: mode as any });
        console.log(chalk.green(`✓ Permission mode set to: ${mode}\n`));
      } else {
        console.log(chalk.yellow(`Current mode: ${getState().permissionMode}\n`));
      }
      break;

    case '/tools':
      const tools = toolRegistry.getAllTools();
      console.log(chalk.bold('\n🔧 Available Tools:'));
      for (const tool of tools) {
        const readOnly = tool.isReadOnly ? chalk.green(' [read-only]') : '';
        console.log(chalk.gray(`  - ${tool.name}${readOnly}`));
      }
      console.log();
      break;

    case '/status':
      const state = getState();
      console.log(chalk.bold('\n📊 Status:'));
      console.log(chalk.gray(`  CWD: ${state.cwd}`));
      console.log(chalk.gray(`  Mode: ${state.permissionMode}`));
      console.log(chalk.gray(`  Session: ${state.sessionId}`));
      console.log();
      break;

    case '/exit':
      console.log(chalk.yellow('\n👋 Goodbye!'));
      rl.close();
      process.exit(0);
      break;

    default:
      console.log(chalk.yellow(`Unknown command: ${cmd}. Type /help for available commands.\n`));
  }
}

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

import type { ToolDefinition } from './types/tools';

function buildSystemPrompt(tools: ToolDefinition[]): string {
  const toolNames = tools.map(t => t.name).join(', ');

  return `You are CC-CLI, an intelligent CLI agent that helps with software development tasks.

You have access to the following tools: ${toolNames}

Guidelines:
1. Always think step-by-step before taking action
2. Use tools to gather information before making changes
3. Be careful with destructive operations
4. Explain what you're doing and why
5. Ask for clarification when needed
6. Follow best practices for code quality and security

Available capabilities:
- Read, write, and edit files
- Execute bash commands
- Search code and files
- Git operations
- Web search and fetch
- Database queries
- Docker operations
- Application deployment
- System monitoring
- Compile, test, and run programs

Always work methodically and keep the user informed of your progress.`;
}

// Run main
main().catch((error) => {
  console.error(chalk.red('Fatal error:'), error);
  process.exit(1);
});
