import { useState, useEffect, useCallback, useRef } from 'react';
import type { UIEventBus } from '../event-bus';
import type { ChatMessage, ThinkingChain, ToolCallData, SidebarData } from '../view-protocol';
import { createSidebarData, classifyThinkingSteps, summarizeToolInput } from '../view-protocol';
import { normalizeUIEvent } from '../event-normalizer';
import { formatUserFacingError } from '../../utils/errors';
import type { AgentEvent } from '../../state/types';
import type { StreamEvent } from '../../query/protocol';

/** Live engine activity derived from the event stream (drives the status bar). */
export type StreamActivity = 'idle' | 'streaming' | 'executing' | 'error';

export interface StreamingState {
  messages: ChatMessage[];
  thinkingChains: Map<string, ThinkingChain>;
  sidebarData: SidebarData;
  isStreaming: boolean;
  /** Fine-grained live activity: streaming LLM text vs executing tools vs error. */
  activity: StreamActivity;
  errors: string[];
  totalTokensUsed: number;
}

export function useStreamingEvents(eventBus: UIEventBus): StreamingState & {
  addMessage: (msg: ChatMessage) => void;
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
} {
  // Use refs for mutable state to avoid stale closures in event handlers
  const messagesRef = useRef<ChatMessage[]>([]);
  const thinkingChainsRef = useRef<Map<string, ThinkingChain>>(new Map());
  const sidebarDataRef = useRef<SidebarData>(createSidebarData());
  const currentThinkingChainRef = useRef<ThinkingChain | null>(null);
  const currentAssistantIdRef = useRef<string | null>(null);
  const totalTokensUsedRef = useRef<number>(0);

  // Render state (updated to trigger re-renders)
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [thinkingChains, setThinkingChains] = useState<Map<string, ThinkingChain>>(new Map());
  const [sidebarData, setSidebarData] = useState<SidebarData>(createSidebarData());
  const [isStreaming, setIsStreaming] = useState(false);
  const [activity, setActivity] = useState<StreamActivity>('idle');
  const [errors, setErrors] = useState<string[]>([]);
  const [totalTokensUsed, setTotalTokensUsed] = useState(0);

  // Pending coalesced render timer. High-frequency delta events (text/thinking)
  // only schedule a flush instead of cloning the whole message tree per token;
  // lifecycle events flush immediately. This keeps long conversations from
  // paying an O(n) array/Map clone + full reconciliation on every streamed token.
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushRender = useCallback(() => {
    if (flushTimerRef.current !== null) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    setMessages([...messagesRef.current]);
    setThinkingChains(new Map(thinkingChainsRef.current));
    setSidebarData({ ...sidebarDataRef.current });
  }, []);

  // Schedule a coalesced render on the next frame (~33ms) so bursts of delta
  // events collapse into a single React update.
  const scheduleRender = useCallback(() => {
    if (flushTimerRef.current !== null) return;
    flushTimerRef.current = setTimeout(() => {
      flushTimerRef.current = null;
      flushRender();
    }, 33);
  }, [flushRender]);

  useEffect(() => {
    const unsubscribe = eventBus.on('*', (event: AgentEvent | StreamEvent) => {
      const normalized = normalizeUIEvent(event);
      const type = normalized.type;
      const ev = normalized.raw as any;
      const assistantId = currentAssistantIdRef.current;

      // Close out the last running tool card + sidebar entry with a final
      // status. Shared by tool_completed / tool_failed / tool_permission_denied
      // so no lifecycle path leaves a tool stuck in 'running'.
      const finalizeLastRunningTool = (
        status: ToolCallData['status'],
        output: string | undefined,
        toolName: string | undefined,
      ): void => {
        if (assistantId !== null) {
          const msgs = messagesRef.current;
          const idx = msgs.findIndex((m) => m.id === assistantId);
          if (idx >= 0) {
            const toolCalls = [...(msgs[idx].toolCalls || [])];
            for (let i = toolCalls.length - 1; i >= 0; i--) {
              const tc = toolCalls[i]!;
              if (tc.status === 'running' && (toolName === undefined || tc.toolName === toolName)) {
                tc.status = status;
                tc.endTime = Date.now();
                if (output !== undefined) tc.output = output;
                break;
              }
            }
            msgs[idx] = { ...msgs[idx], toolCalls };
            messagesRef.current = [...msgs];
          }
        }
        // Close out the matching sidebar entry (last running tool with this
        // name) so the Tools panel reflects the real lifecycle + duration.
        const sidebarTools = sidebarDataRef.current.tools;
        for (let i = sidebarTools.length - 1; i >= 0; i--) {
          const entry = sidebarTools[i];
          if (entry.status === 'running' && (toolName === undefined || entry.name === toolName)) {
            entry.status = status === 'completed' ? 'completed' : 'failed';
            if (entry.startTime !== undefined) {
              entry.duration = `${((Date.now() - entry.startTime) / 1000).toFixed(1)}s`;
            }
            break;
          }
        }
      };

      switch (type) {
        case 'text_delta': {
          // QueryEngine emits turn_complete per internal turn; a follow-up turn
          // within the same query streams more text after the ref was cleared.
          // Open a fresh assistant bubble instead of dropping that output.
          let targetId = assistantId;
          if (targetId === null) {
            targetId = `assistant_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            currentAssistantIdRef.current = targetId;
            messagesRef.current = [
              ...messagesRef.current,
              { id: targetId, role: 'assistant', content: '', timestamp: Date.now() },
            ];
            setIsStreaming(true);
          }
          setActivity('streaming');
          const msgs = messagesRef.current;
          const idx = msgs.findIndex((m) => m.id === targetId);
          if (idx >= 0) {
            // Mutate the entry in place; the coalesced flush produces the single
            // fresh array copy React needs (avoids a clone per streamed token).
            msgs[idx] = { ...msgs[idx], content: (msgs[idx].content || '') + ev.text };
          }
          scheduleRender();
          break;
        }

        case 'thinking_delta': {
          const chain = currentThinkingChainRef.current || {
            steps: [],
            rawContent: '',
            folded: true,
            startTime: Date.now(),
          };
          const rawContent = chain.rawContent + ev.thinking;
          currentThinkingChainRef.current = {
            ...chain,
            rawContent,
            steps: classifyThinkingSteps(rawContent),
          };
          // Publish the live chain immediately so ChatMessagesView can render
          // thinking progress during the stream (not only after turn_complete).
          if (assistantId !== null) {
            thinkingChainsRef.current.set(assistantId, currentThinkingChainRef.current);
          }
          scheduleRender();
          break;
        }

        case 'tool_started':
        case 'tool_use_start': {
          const toolCall: ToolCallData = {
            toolName: ev.toolCall.toolName,
            input: summarizeToolInput(ev.toolCall.input),
            status: 'running' as const,
            startTime: Date.now(),
          };
          if (assistantId !== null) {
            const msgs = messagesRef.current;
            const idx = msgs.findIndex((m) => m.id === assistantId);
            if (idx >= 0) {
              msgs[idx] = { ...msgs[idx], toolCalls: [...(msgs[idx].toolCalls || []), toolCall] };
              messagesRef.current = [...msgs];
            }
          }
          sidebarDataRef.current.tools.push({
            name: ev.toolCall.toolName,
            status: 'running',
            detail: summarizeToolInput(ev.toolCall.input),
            startTime: toolCall.startTime,
          });
          setActivity('executing');
          flushRender();
          break;
        }

        case 'tool_completed':
        case 'tool_use_end': {
          const failed = 'isError' in ev ? ev.result.isError : false;
          const status: ToolCallData['status'] = failed ? 'failed' : 'completed';
          const output = typeof ev.result?.output === 'string'
            ? ev.result.output
            : ev.result !== undefined ? JSON.stringify(ev.result.output) : undefined;
          finalizeLastRunningTool(status, output, ev.toolCall?.toolName);
          setActivity('streaming');
          flushRender();
          break;
        }

        case 'tool_failed': {
          // agent:tool_failed carries an Error instead of a result. Without
          // this branch the tool card stayed 'running' forever (silent failure).
          const errText = formatUserFacingError(ev.error);
          finalizeLastRunningTool('failed', errText, ev.toolCall?.toolName);
          setActivity('streaming');
          flushRender();
          break;
        }

        case 'tool_permission_denied': {
          const reason = typeof ev.reason === 'string' && ev.reason.trim()
            ? ev.reason
            : 'Permission denied';
          finalizeLastRunningTool(
            'failed',
            `[tool_permission_denied] ${reason} — Suggestion: adjust permission mode (/mode) or approve the request when prompted.`,
            ev.toolCall?.toolName,
          );
          setActivity('streaming');
          flushRender();
          break;
        }

        case 'turn_complete': {
          currentAssistantIdRef.current = null;
          setIsStreaming(false);
          setActivity('idle');
          const chain = currentThinkingChainRef.current;
          if (chain && assistantId) {
            // Freeze the displayed duration now that the turn is done.
            thinkingChainsRef.current.set(assistantId, { ...chain, endTime: Date.now() });
          }
          currentThinkingChainRef.current = null;

          // Track token usage from turn_complete events (agent:turn_complete has usage)
          if (ev.usage && typeof ev.usage.totalTokens === 'number') {
            totalTokensUsedRef.current += ev.usage.totalTokens;
            setTotalTokensUsed(totalTokensUsedRef.current);
          }

          flushRender();
          break;
        }

        case 'error': {
          // Surface a structured, actionable message (stable error code +
          // suggestion) instead of a bare error string.
          const errorMsg = ev.error !== undefined ? formatUserFacingError(ev.error) : 'Unknown error';
          setErrors((prev) => [...prev, errorMsg]);
          // A stream error means the turn will never emit turn_complete, so we
          // must clear the streaming flag here — otherwise isStreaming stays
          // true forever and AppRoot's useInput guard swallows all subsequent
          // input (user can't type a second message).
          currentAssistantIdRef.current = null;
          currentThinkingChainRef.current = null;
          setIsStreaming(false);
          setActivity('error');
          flushRender();
          break;
        }
      }
    });

    return () => {
      unsubscribe();
      if (flushTimerRef.current !== null) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
    };
  }, [eventBus, flushRender, scheduleRender]);

  const addMessage = useCallback((msg: ChatMessage) => {
    messagesRef.current = [...messagesRef.current, msg];
    setMessages([...messagesRef.current]);
    if (msg.role === 'assistant') {
      currentAssistantIdRef.current = msg.id;
      setIsStreaming(true);
    }
  }, []);

  return {
    messages,
    thinkingChains,
    sidebarData,
    isStreaming,
    activity,
    errors,
    totalTokensUsed,
    addMessage,
    setMessages,
  };
}
