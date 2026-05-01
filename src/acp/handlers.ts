// ACP Request Handlers - extracted from server.ts for separation of concerns

import type { ACPRequest, ACPResponse, ACPNotification, ACPSessionInfo } from './types';
import { QueryEngine } from '../query/QueryEngine';
import { toolRegistry, registerBuiltInTools } from '../tools';
import { initializeState, getState } from '../bootstrap/state';
import { loadConfig } from '../bootstrap/config';
import type { AgentEvent } from '../state/types';
import type { StreamEvent } from '../types/message';
import { v4 as uuidv4 } from 'uuid';

export interface ACPHandlerState {
  sessions: Map<string, { engine: QueryEngine; info: ACPSessionInfo }>;
  sendResult: (id: number | string, result: unknown) => void;
  sendError: (id: number | string | null, code: number, message: string) => void;
  sendNotification: (method: string, params?: Record<string, unknown>) => void;
}

export async function handleInitialize(request: ACPRequest, state: ACPHandlerState): Promise<void> {
  const cwd = (request.params?.cwd as string) || process.cwd();
  const model = (request.params?.model as string) || 'deepseek-v4-pro';
  const provider = (request.params?.provider as string) || 'deepseek';

  initializeState({ cwd, verbose: false, printMode: false, bareMode: false, permissionMode: 'default' });
  await registerBuiltInTools();

  state.sendResult(request.id, {
    protocolVersion: '1.0',
    serverInfo: { name: 'kc-cli', version: '0.1.0' },
    capabilities: { tools: true, streaming: true },
  });
}

export async function handleAgentRun(request: ACPRequest, state: ACPHandlerState): Promise<void> {
  const prompt = request.params?.prompt as string;
  const sessionId = (request.params?.sessionId as string) || uuidv4();

  if (!prompt) {
    state.sendError(request.id, -32602, 'Missing required parameter: prompt');
    return;
  }

  const { config } = await loadConfig(getState().cwd);
  const tools = toolRegistry.getAllTools();
  const systemPrompt = 'You are KC-CLI, an intelligent CLI agent.';

  const engine = new QueryEngine({
    model: config.model,
    provider: config.provider as any,
    apiKey: config.apiKey,
    apiBaseUrl: config.apiBaseUrl,
    maxTurns: 50,
    maxBudgetUsd: null,
    systemPrompt,
  }, tools);

  const sessionInfo: ACPSessionInfo = {
    sessionId,
    model: config.model,
    provider: config.provider,
    status: 'running',
    createdAt: Date.now(),
  };

  state.sessions.set(sessionId, { engine, info: sessionInfo });

  state.sendResult(request.id, { sessionId, status: 'started' });

  // Run in background
  runAgent(sessionId, engine, prompt, state).catch(() => {});
}

async function runAgent(
  sessionId: string,
  engine: QueryEngine,
  prompt: string,
  state: ACPHandlerState
): Promise<void> {
  const session = state.sessions.get(sessionId);
  if (!session) return;

  try {
    for await (const event of engine.submitMessage(prompt)) {
      state.sendNotification('agent/event', {
        sessionId,
        event: serializeEvent(event),
      });
    }
    session.info.status = 'completed';
    state.sendNotification('agent/done', { sessionId });
  } catch (error) {
    session.info.status = 'error';
    state.sendNotification('agent/error', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function handleAgentCancel(request: ACPRequest, state: ACPHandlerState): void {
  const sessionId = request.params?.sessionId as string;
  const session = state.sessions.get(sessionId);

  if (!session) {
    state.sendError(request.id, -32602, `Session not found: ${sessionId}`);
    return;
  }

  session.engine.abort('User cancelled');
  session.info.status = 'completed';
  state.sendResult(request.id, { sessionId, status: 'cancelled' });
}

export function handleSessionList(request: ACPRequest, state: ACPHandlerState): void {
  const sessions = Array.from(state.sessions.values()).map(s => s.info);
  state.sendResult(request.id, { sessions });
}

function serializeEvent(event: AgentEvent | StreamEvent): Record<string, unknown> {
  if ('type' in event && event.type.startsWith('agent:')) {
    const ae = event as AgentEvent;
    switch (ae.type) {
      case 'agent:text_delta':
        return { type: 'text', text: (ae as any).text };
      case 'agent:tool_started':
        return { type: 'tool_start', tool: (ae as any).toolCall?.toolName };
      case 'agent:tool_completed':
        return { type: 'tool_end', tool: (ae as any).toolCall?.toolName, success: true };
      case 'agent:tool_failed':
        return { type: 'tool_end', tool: (ae as any).toolCall?.toolName, success: false, error: (ae as any).error?.message };
      case 'agent:error':
        return { type: 'error', message: (ae as any).error?.message };
      case 'agent:complete':
        return { type: 'complete' };
      default:
        return { type: ae.type };
    }
  }
  return { type: (event as any).type };
}
