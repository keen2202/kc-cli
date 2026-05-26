#!/usr/bin/env node

// KC-CLI: Intelligent CLI Agent System
// Main entry point

import { Command } from 'commander';
import chalk from 'chalk';
import * as path from 'path';
import { getErrorMessage } from './types/errors';

import { profileCheckpoint, getProfileReport } from './bootstrap/profiler';
import { initializeState, getState, updateState } from './bootstrap/state';
import { loadConfig } from './bootstrap/config';
import { toolRegistry, registerBuiltInTools } from './tools';
import { QueryEngine } from './query/QueryEngine';
import type { AgentEvent } from './state/types';
import type { StreamEvent } from './types/message';
import type { LLMProvider } from './api';
import type { PermissionMode } from './types/permissions';
import { formatToolResult, formatBanner, formatSeparator, setBareMode } from './ui';
import { Spinner } from './ui/spinner';
import { updateStatus, clearStatus } from './ui/statusline';
import { MCPClientManager, convertMCPTool, loadMCPConfig } from './mcp';
import { UserProfileService } from './services/userProfile';
import type { UserLevel } from './services/userProfile';
import { setLogLevel } from './services/logger';
import type { LogLevel } from './services/logger';

// Apply LOG_LEVEL env var at startup
if (process.env.LOG_LEVEL) {
  const validLevels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
  const level = process.env.LOG_LEVEL.toLowerCase() as LogLevel;
  if (validLevels.includes(level)) {
    setLogLevel(level);
  }
}

let currentSpinner: Spinner | null = null;

const VERSION = '0.1.0';

const BANNER = formatBanner(VERSION);

async function main() {
  profileCheckpoint('start');

  const program = new Command();

  program
    .name('kc')
    .description('KC-CLI - Intelligent CLI Agent System')
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
    .option('--acp', 'Run as ACP server (JSON-RPC over stdio)')
    .action(async (prompt: string | undefined, opts: any) => {
      if (opts.acp) {
        const { ACPServer } = await import('./acp');
        const server = new ACPServer();
        await server.start();
        return;
      }
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

  if (opts.bare) {
    setBareMode(true);
  }

  profileCheckpoint('state_init');

  // Phase 2: Load configuration
  const { config, layers } = await loadConfig(cwd);
  updateState({ config });

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

  // Phase 3b: Initialize MCP servers (parallel connection)
  let mcpManager: MCPClientManager | null = null;
  if (!opts.bare) {
    try {
      const mcpConfig = await loadMCPConfig(cwd);
      if (Object.keys(mcpConfig.servers).length > 0) {
        mcpManager = new MCPClientManager();

        // Connect to all MCP servers in parallel
        const connectionTimeout = 30000; // 30 seconds per server
        const connectionPromises = Object.entries(mcpConfig.servers).map(
          async ([serverId, serverConfig]) => {
            const timeoutPromise = new Promise<never>((_, reject) => {
              setTimeout(() => reject(new Error(`Connection timeout after ${connectionTimeout / 1000}s`)), connectionTimeout);
            });

            try {
              await Promise.race([
                mcpManager!.connect(serverId, serverConfig),
                timeoutPromise,
              ]);
              const mcpTools = mcpManager!.getServerTools(serverId);
              for (const mcpTool of mcpTools) {
                const toolDef = convertMCPTool(mcpTool, serverId, mcpManager!);
                toolRegistry.registerMCPTool(toolDef);
              }
              if (opts.verbose) {
                console.log(chalk.gray(`  MCP: ${serverId} (${mcpTools.length} tools)`));
              }
              return { serverId, success: true, toolCount: mcpTools.length };
            } catch (error) {
              console.warn(chalk.yellow(`Warning: MCP server "${serverId}" failed to connect: ${error instanceof Error ? error.message : error}`));
              return { serverId, success: false, error };
            }
          }
        );

        // Wait for all connections to complete (success or failure)
        const results = await Promise.allSettled(connectionPromises);

        // Log summary
        const succeeded = results.filter(r => r.status === 'fulfilled' && r.value.success).length;
        const failed = results.length - succeeded;
        if (failed > 0) {
          console.log(chalk.yellow(`MCP: ${succeeded} connected, ${failed} failed`));
        }
      }
    } catch (_err) {
      console.error("Suppressed error:", _err);
      // MCP config loading is optional, ignore errors
    }
  }
  profileCheckpoint('mcp_initialized');

  // Phase 3c: Initialize plugins
  let pluginManager: import('./plugins/plugin-manager').PluginManager | null = null;
  if (!opts.bare) {
    try {
      const { PluginManager } = await import('./plugins');
      pluginManager = new PluginManager();
      await pluginManager.loadAll(cwd);
      await pluginManager.initAll();
      const pluginTools = pluginManager.getPluginTools();
      for (const tool of pluginTools) {
        toolRegistry.registerPluginTool(tool);
      }
      if (opts.verbose && pluginTools.length > 0) {
        console.log(chalk.gray(`  Plugins: ${pluginTools.length} tool(s) loaded`));
      }
    } catch (_err) {
      console.error("Suppressed error:", _err);
      // Plugin loading is optional
    }
  }
  profileCheckpoint('plugins_initialized');

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
      provider: provider as LLMProvider,
      apiKey,
      apiBaseUrl,
      maxTurns: getState().maxTurns || 50,
      maxBudgetUsd: getState().maxBudgetUsd,
      systemPrompt,
      permissionRules: {
        deny: config.permissions.deny,
        ask: config.permissions.ask,
        allow: config.permissions.allow,
      },
    },
    tools
  );

  profileCheckpoint('engine_created');

  updateStatus({
    provider,
    model,
    maxTurns: getState().maxTurns || 50,
    sessionStartTime: Date.now(),
  });

  // Phase 5: Run REPL or single prompt
  if (prompt) {
    // Single prompt mode
    await executePrompt(queryEngine, prompt);
  } else if (!opts.bare && process.stdout.isTTY) {
    // Ink-based interactive UI
    const { renderInkUI } = await import('./ui/renderer');
    renderInkUI({
      queryEngine,
      provider,
      model,
      maxTurns: getState().maxTurns || 50,
    });
  } else {
    // Fallback readline REPL (bare mode or non-TTY)
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
      chalk.red(`\n❌ Fatal error: ${getErrorMessage(error)}`)
    );
    process.exit(1);
  }
}

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
    rl.question(chalk.cyan.bold('kc> '), async (input) => {
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
          chalk.red(`\n❌ Error: ${getErrorMessage(error)}`)
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
      console.log(chalk.gray('  /level [level] - Show/set user level (beginner|intermediate|advanced)'));
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
        updateState({ permissionMode: mode as PermissionMode });
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

  return `You are KC-CLI, an intelligent CLI agent that helps with software development tasks.

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
