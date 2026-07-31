// Tool-call execution phase, extracted from QueryEngine (architecture 4e):
// parallel tool execution, file-modification tracking + undo journal (T3/H3),
// git auto-stage (T4/H4) and runtime-control bookkeeping (harness-evolution
// T2/H2). Pure move of QueryEngine.executingPhase — no behavior or event change.

import { v4 as uuidv4 } from 'uuid';
import { getState } from '../bootstrap/state';
import { autoStageFile } from '../utils/git';
import type { AgentEvent } from '../state/types';
import type { AssistantMessage, ChatMessage, StreamEvent, ToolResult } from './protocol';
import type { ToolExecutor } from '../executors/toolExecutor';
import type { ToolUseContext } from '../tools/protocol';
import type { ConversationState } from './QueryEngineState';
import type { RuntimeControlHandler } from './QueryEngineRuntimeControl';
import type { FileOperationJournal } from '../state/file-operation-journal';
import type { ProgressTracker } from './QueryEngineTurnControl';
import { toolStartedEvent, toolCompletedEvent, toolFailedEvent } from './QueryEngineEvents';

/** Everything the execution phase needs from the engine, passed per call. */
export interface ExecutionDeps {
  conversation: ConversationState;
  toolExecutor: ToolExecutor;
  runtimeControl: RuntimeControlHandler;
  fileJournal: FileOperationJournal;
  modifiedFiles: Set<string>;
  progress: ProgressTracker;
  getTurnCount(): number;
  toolContext: ToolUseContext;
}

/**
 * Execute the tool calls of the latest assistant message: hard-mode retry
 * rejection, parallel execution, modification/journal/auto-stage tracking,
 * and tool-result message appending.
 */
export async function* executeToolCalls(deps: ExecutionDeps): AsyncGenerator<StreamEvent | AgentEvent> {
  const lastMsg = deps.conversation.getLastMessage();
  if (!lastMsg || lastMsg.role !== 'assistant') return;

  const assistantMsg = lastMsg as AssistantMessage;
  const toolCalls = assistantMsg.toolCalls || [];

  for (const tc of toolCalls) {
    yield toolStartedEvent(tc);
  }

  // harness-evolution T2 (H2): hard-mode retry-discipline gate — identical
  // calls that already exhausted their failure budget are rejected without
  // executing (synthetic error result). No-op unless the policy enables it.
  const rejectedResults = new Map<string, ToolResult>();
  const executableCalls = toolCalls.filter(tc => {
    const rejection = deps.runtimeControl.checkHardReject(tc.toolName, tc.input);
    if (rejection) {
      rejectedResults.set(tc.id, { toolCallId: tc.id, output: rejection, isError: true });
      return false;
    }
    return true;
  });

  const results = await deps.toolExecutor.executeParallel(
    executableCalls,
    deps.toolContext
  );
  for (const [id, rejected] of rejectedResults) {
    results.set(id, rejected);
  }

  for (const [toolCallId, result] of results) {
    const toolCall = toolCalls.find(tc => tc.id === toolCallId);
    if (!toolCall) continue;

    // Track file modifications for incremental memory and patch guarantee
    if (!(result instanceof Error) && !result.isError) {
      const toolName = toolCall.toolName;
      if (toolName === 'FileWrite' || toolName === 'FileEdit') {
        const metadata = (result as ToolResult).metadata as Record<string, unknown> | undefined;
        const filePath = (metadata?.path || metadata?.file_path) as string | undefined;
        if (filePath) {
          deps.modifiedFiles.add(filePath);
          deps.progress.lastModifiedTurn = deps.getTurnCount();
          // T3 (H3): record the mutation in the session undo journal so the
          // FileRestore tool can revert it. old/new content + backupPath are
          // supplied by the T2 atomic-write metadata.
          deps.fileJournal.record({
            filePath,
            operation: toolName === 'FileWrite' ? 'write' : 'edit',
            oldContent: (metadata?.oldContent ?? null) as string | null,
            newContent: (metadata?.newContent ?? null) as string | null,
            backupPath: (metadata?.backupPath ?? null) as string | null,
            turn: deps.getTurnCount(),
          });
          // Auto-stage file (fire-and-forget git add). T4 (H4): skip when the
          // workspace is known to be non-Git so we don't spawn a doomed
          // `git add` (Bootstrap already surfaced the safety-net warning once).
          if (getState().isGitRepo !== false) {
            void autoStageFile(filePath, getState().cwd);
          }
        }
      }
    }

    if (result instanceof Error) {
      yield toolFailedEvent(toolCall, result);
    } else if (result.isError) {
      yield toolFailedEvent(toolCall, new Error(result.output));
    } else {
      yield toolCompletedEvent(toolCall, result as ToolResult);
    }

    // harness-evolution T2 (H2): repeated-failure context is appended to the
    // error output text (active regardless of the policy switch), then the
    // outcome is recorded for retry-discipline / cap tracking.
    const isErrorResult = result instanceof Error || result.isError === true;
    const repeatContext = isErrorResult
      ? deps.runtimeControl.getRepeatedFailureContext(toolCall.toolName, toolCall.input)
      : null;
    deps.runtimeControl.recordToolResult(toolCall.toolName, toolCall.input, isErrorResult);
    const errorSuffix = repeatContext ? `\n\n${repeatContext}` : '';

    // Add tool result as message. Always preserve toolCallId so the tool
    // message can be paired with the originating assistant tool_call — an
    // Error result would otherwise drop it and break the OpenAI contract.
    const toolResultMsg: ChatMessage = {
      id: uuidv4(),
      role: 'tool',
      content: (result instanceof Error ? result.message : (result as ToolResult).output) + errorSuffix,
      toolResults: [
        result instanceof Error
          ? { toolCallId, output: result.message + errorSuffix, isError: true }
          : errorSuffix
            ? { ...(result as ToolResult), output: (result as ToolResult).output + errorSuffix }
            : (result as ToolResult),
      ],
      timestamp: Date.now(),
    };
    deps.conversation.addMessage(toolResultMsg);
  }

  // harness-evolution T2 (H2): turn composition feeds the exploration-loop breaker.
  deps.runtimeControl.recordTurn(toolCalls.map(tc => tc.toolName));
}
