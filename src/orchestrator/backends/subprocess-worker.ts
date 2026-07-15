// Subprocess worker — runs inside child_process.fork()
// Hosts a QueryEngine loop for a single sub-agent.
// Communicates with the parent via IPC (process.send / process.on('message')).

import type { AgentEvent } from '../../state/types.js';
import type { StreamEvent } from '../../query/protocol.js';
import type { SubAgentResult, SubAgentSpawnConfig } from '../protocol.js';

interface ParentMessage {
  type: 'init' | 'shutdown' | 'message';
  config?: SubAgentSpawnConfig;
  permissionMode?: string;
  cwd?: string;
  message?: unknown;
  force?: boolean;
}

let aborted = false;
let queryEngine: { submitMessage(m: string): AsyncGenerator<StreamEvent | AgentEvent>; abort(r?: string): void } | null = null;

// Signal readiness immediately at module load — parent will send 'init' upon
// receiving this. Previously this was inside runAgentLoop() which is only called
// after receiving 'init', causing a deadlock where both sides waited for each other.
// FUN-01 fix.
process.send!({ type: 'ready' });

process.on('message', async (msg: ParentMessage) => {
  if (!msg || typeof msg.type !== 'string') return;

  switch (msg.type) {
    case 'init': {
      if (!msg.config) {
        process.send!({ type: 'error', error: { message: 'Missing config in init message' } });
        return;
      }
      try {
        await runAgentLoop(msg.config, msg.cwd || process.cwd());
      } catch (err) {
        process.send!({
          type: 'error',
          error: {
            message: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
          },
        });
      }
      break;
    }

    case 'message': {
      // Inter-agent message — could be forwarded as user input
      if (msg.message && queryEngine && !aborted) {
        try {
          const m = msg.message as { type: string; payload: Record<string, unknown> };
          if (m.type === 'user_message' && m.payload?.text) {
            const iter = queryEngine.submitMessage(m.payload.text as string);
            for await (const event of iter) {
              process.send!({ type: 'event', event });
            }
          }
        } catch (err) {
          process.send!({
            type: 'error',
            error: { message: String(err) },
          });
        }
      }
      break;
    }

    case 'shutdown': {
      aborted = true;
      if (queryEngine) {
        queryEngine.abort(msg.force ? 'Force shutdown' : 'Graceful shutdown');
      }
      setTimeout(() => process.exit(0), 1000);
      break;
    }
  }
});

async function runAgentLoop(config: SubAgentSpawnConfig, cwd: string): Promise<void> {

  // Dynamically import QueryEngine (isolated in this process)
  const { QueryEngine } = await import('../../query/QueryEngine');

  const qe = new QueryEngine(
    {
      model: config.model || 'claude-sonnet-4-20250514',
      provider: 'anthropic',
      maxTurns: config.maxTurns || 15,
      maxBudgetUsd: null,
      systemPrompt: config.systemPrompt,
    },
    [] // Tools are managed by the parent; child runs prompts only
  );

  queryEngine = qe;

  const startedAt = Date.now();
  let toolUseCount = 0;
  let totalTokensUsed = 0;
  let lastOutput = '';

  try {
    const generator = qe.submitMessage(config.prompt);

    for await (const rawEvent of generator) {
      if (aborted) break;

      const event = rawEvent as AgentEvent;
      process.send!({ type: 'event', event });

      if (event.type === 'agent:tool_completed') {
        toolUseCount++;
        totalTokensUsed += Number(event.result?.metadata?.tokensUsed) || 0;
      } else if (event.type === 'agent:turn_complete') {
        if (event.message?.content) {
          lastOutput = event.message.content;
        }
      }
    }

    const result: SubAgentResult = {
      agentId: process.env.KC_AGENT_ID || 'unknown',
      name: config.name,
      success: !aborted,
      output: lastOutput || 'No output generated',
      toolUseCount,
      totalTokensUsed,
      duration: Date.now() - startedAt,
    };

    process.send!({ type: 'result', result });
  } catch (err) {
    process.send!({
      type: 'error',
      error: {
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      },
    });
  }
}

// Handle uncaught errors
process.on('uncaughtException', (err) => {
  process.send!({
    type: 'error',
    error: { message: `Uncaught: ${err.message}`, stack: err.stack },
  });
  setTimeout(() => process.exit(1), 500);
});

process.on('unhandledRejection', (reason) => {
  process.send!({
    type: 'error',
    error: { message: `Unhandled rejection: ${String(reason)}` },
  });
});
