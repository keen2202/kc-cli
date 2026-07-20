import { Command } from 'commander';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf-8'));
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}

export const VERSION = readVersion();

export interface CLIDelegates {
  onRunAgent: (prompt: string | undefined, opts: Record<string, any>) => Promise<void>;
  onShowConfig: () => Promise<void>;
  onListTools: () => Promise<void>;
}

export function createProgram(delegates: CLIDelegates): Command {
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
    .option('--auto-extend-turns', 'Automatically extend turn budget when progress is detected')
    .option('-v, --verbose', 'Enable verbose output')
    .option('--print', 'Print response and exit (non-interactive)')
    .option('--bare', 'Minimal mode: skip hooks and heavy initialization')
    .option('--bypass-permissions', 'Bypass all permission checks (requires KC_ALLOW_BYPASS=1)')
    .option('--profile', 'Show startup profile')
    .option('--json', 'Output events as NDJSON (for IDE integration)')
    .option('--json-pretty', 'Output events as formatted JSON (for debugging)')
    .option('--acp', 'Run as ACP server (JSON-RPC over stdio)')
    .option('--im', 'Run in IM bridge mode (connect to configured IM platforms)')
    .action(async (prompt: string | undefined, opts: Record<string, any>) => {
      if (opts.acp) {
        const { ACPServer } = await import('../acp');
        const server = new ACPServer();
        await server.start();
        return;
      }
      await delegates.onRunAgent(prompt, opts);
    });

  program
    .command('config')
    .description('Show current configuration')
    .action(async () => {
      await delegates.onShowConfig();
    });

  program
    .command('tools')
    .description('List available tools')
    .action(async () => {
      await delegates.onListTools();
    });

  return program;
}
