import readline from 'readline';
import chalk from 'chalk';
import { renderStatusBar } from './StatusBar';
import { renderToolCallCard, type ToolCallData } from './ToolCallCard';
import { renderChatView, type ChatMessage } from './ChatView';
import { renderInputBox, createInputState, type InputState } from './InputBox';
import type { QueryEngine } from '../../query/QueryEngine';
import type { AgentEvent } from '../../state/types';
import type { StreamEvent } from '../../types/message';

interface AppOptions {
  queryEngine: QueryEngine;
  provider?: string;
  model?: string;
  maxTurns?: number;
}

export class App {
  private queryEngine: QueryEngine;
  private provider: string;
  private model: string;
  private maxTurns: number;
  private messages: ChatMessage[] = [];
  private inputState: InputState;
  private rl: readline.Interface;
  private turnCount: number = 0;
  private sessionStartTime: number;
  private running: boolean = true;

  constructor(options: AppOptions) {
    this.queryEngine = options.queryEngine;
    this.provider = options.provider || 'unknown';
    this.model = options.model || 'unknown';
    this.maxTurns = options.maxTurns || 50;
    this.inputState = createInputState();
    this.sessionStartTime = Date.now();

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  }

  async start(): Promise<void> {
    this.clearScreen();
    this.render();

    // Graceful shutdown
    const cleanup = () => {
      this.running = false;
      console.log(chalk.yellow('\nGoodbye!'));
      this.rl.close();
      process.exit(0);
    };
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);

    this.prompt();
  }

  private clearScreen(): void {
    process.stdout.write('\x1B[2J\x1B[H');
  }

  private render(): void {
    // Move cursor to top
    process.stdout.write('\x1B[H');

    // Render status bar
    const status = renderStatusBar({
      provider: this.provider,
      model: this.model,
      turnCount: this.turnCount,
      maxTurns: this.maxTurns,
      sessionStartTime: this.sessionStartTime,
    });
    if (status) {
      console.log(status);
    }

    // Render chat view
    if (this.messages.length > 0) {
      console.log(renderChatView(this.messages));
    }

    // Render input box
    console.log(renderInputBox(this.inputState));
  }

  private prompt(): void {
    this.rl.question(chalk.cyan.bold('kc> '), async (input) => {
      if (!this.running) return;

      const trimmed = input.trim();

      // Handle commands
      if (trimmed.startsWith('/')) {
        this.handleCommand(trimmed);
        this.prompt();
        return;
      }

      if (!trimmed) {
        this.prompt();
        return;
      }

      // Add user message
      this.addMessage({
        id: `user-${Date.now()}`,
        role: 'user',
        content: trimmed,
        timestamp: Date.now(),
      });

      // Execute query
      await this.executeQuery(trimmed);

      this.prompt();
    });
  }

  private addMessage(msg: ChatMessage): void {
    this.messages.push(msg);
    this.clearScreen();
    this.render();
  }

  private async executeQuery(prompt: string): Promise<void> {
    const assistantMsg: ChatMessage = {
      id: `assistant-${Date.now()}`,
      role: 'assistant',
      content: null,
      timestamp: Date.now(),
      toolCalls: [],
    };
    this.messages.push(assistantMsg);

    try {
      for await (const event of this.queryEngine.submitMessage(prompt)) {
        this.handleEvent(event, assistantMsg);
      }
    } catch (error) {
      assistantMsg.content = chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }

    this.turnCount++;
    this.clearScreen();
    this.render();
  }

  private handleEvent(event: AgentEvent | StreamEvent, assistantMsg: ChatMessage): void {
    if (event.type.startsWith('agent:')) {
      switch (event.type) {
        case 'agent:text_delta':
          assistantMsg.content = (assistantMsg.content || '') + event.text;
          break;

        case 'agent:tool_started': {
          const toolCall: ToolCallData = {
            toolName: event.toolCall.toolName,
            status: 'running',
            startTime: Date.now(),
          };
          assistantMsg.toolCalls = assistantMsg.toolCalls || [];
          assistantMsg.toolCalls.push(toolCall);
          this.clearScreen();
          this.render();
          break;
        }

        case 'agent:tool_completed': {
          const toolCalls = assistantMsg.toolCalls || [];
          const lastTool = toolCalls[toolCalls.length - 1];
          if (lastTool) {
            lastTool.status = 'completed';
            lastTool.endTime = Date.now();
            lastTool.output = typeof event.result.output === 'string'
              ? event.result.output
              : JSON.stringify(event.result.output);
          }
          this.clearScreen();
          this.render();
          break;
        }

        case 'agent:tool_failed': {
          const toolCalls = assistantMsg.toolCalls || [];
          const lastTool = toolCalls[toolCalls.length - 1];
          if (lastTool) {
            lastTool.status = 'failed';
            lastTool.endTime = Date.now();
            lastTool.output = event.error.message;
          }
          this.clearScreen();
          this.render();
          break;
        }
      }
    } else {
      switch (event.type) {
        case 'text_delta':
          assistantMsg.content = (assistantMsg.content || '') + event.text;
          break;

        case 'tool_use_start': {
          const toolCall: ToolCallData = {
            toolName: event.toolCall.toolName,
            status: 'running',
            startTime: Date.now(),
          };
          assistantMsg.toolCalls = assistantMsg.toolCalls || [];
          assistantMsg.toolCalls.push(toolCall);
          this.clearScreen();
          this.render();
          break;
        }

        case 'tool_use_end': {
          const toolCalls = assistantMsg.toolCalls || [];
          const lastTool = toolCalls[toolCalls.length - 1];
          if (lastTool) {
            lastTool.status = event.result.isError ? 'failed' : 'completed';
            lastTool.endTime = Date.now();
            lastTool.output = typeof event.result.output === 'string'
              ? event.result.output
              : JSON.stringify(event.result.output);
          }
          this.clearScreen();
          this.render();
          break;
        }
      }
    }
  }

  private handleCommand(command: string): void {
    const parts = command.split(' ');
    const cmd = parts[0]!.toLowerCase();

    switch (cmd) {
      case '/help':
        this.addMessage({
          id: `system-${Date.now()}`,
          role: 'system',
          content: [
            'Available Commands:',
            '  /help   - Show this help',
            '  /clear  - Clear conversation',
            '  /status - Show current status',
            '  /exit   - Exit',
          ].join('\n'),
          timestamp: Date.now(),
        });
        break;

      case '/clear':
        this.messages = [];
        this.turnCount = 0;
        this.addMessage({
          id: `system-${Date.now()}`,
          role: 'system',
          content: 'Conversation cleared.',
          timestamp: Date.now(),
        });
        break;

      case '/status':
        this.addMessage({
          id: `system-${Date.now()}`,
          role: 'system',
          content: [
            `Provider: ${this.provider}`,
            `Model: ${this.model}`,
            `Turns: ${this.turnCount}/${this.maxTurns}`,
          ].join('\n'),
          timestamp: Date.now(),
        });
        break;

      case '/exit':
        this.running = false;
        console.log(chalk.yellow('\nGoodbye!'));
        this.rl.close();
        process.exit(0);
        break;

      default:
        this.addMessage({
          id: `system-${Date.now()}`,
          role: 'system',
          content: `Unknown command: ${cmd}. Type /help for available commands.`,
          timestamp: Date.now(),
        });
    }
  }
}

export async function runApp(options: AppOptions): Promise<void> {
  const app = new App(options);
  await app.start();
}
