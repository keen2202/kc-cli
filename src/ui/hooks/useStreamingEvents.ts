import { useState, useEffect, useCallback, useRef } from 'react';
import type { UIEventBus } from '../event-bus';
import type { ChatMessage } from '../components/ChatView';
import type { ThinkingChain } from '../components/ThinkingChainView';
import type { ToolCallData } from '../components/ToolCallCard';
import type { SidebarData } from '../components/Sidebar';
import { createSidebarData } from '../components/Sidebar';
import { classifyThinkingSteps } from '../components/ThinkingChainView';
import { normalizeUIEvent } from '../event-normalizer';
import type { AgentEvent } from '../../state/types';
import type { StreamEvent } from '../../query/protocol';

export interface StreamingState {
  messages: ChatMessage[];
  thinkingChains: Map<string, ThinkingChain>;
  sidebarData: SidebarData;
  isStreaming: boolean;
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

      switch (type) {
        case 'text_delta': {
          if (assistantId === null) break;
          const msgs = messagesRef.current;
          const idx = msgs.findIndex((m) => m.id === assistantId);
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
          scheduleRender();
          break;
        }

        case 'tool_started':
        case 'tool_use_start': {
          const toolCall: ToolCallData = {
            toolName: ev.toolCall.toolName,
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
          sidebarDataRef.current.tools.push({ name: ev.toolCall.toolName, status: 'running' });
          flushRender();
          break;
        }

        case 'tool_completed':
        case 'tool_use_end': {
          const failed = 'isError' in ev ? ev.result.isError : false;
          const status: ToolCallData['status'] = failed ? 'failed' : 'completed';
          if (assistantId !== null) {
            const msgs = messagesRef.current;
            const idx = msgs.findIndex((m) => m.id === assistantId);
            if (idx >= 0) {
              const toolCalls = [...(msgs[idx].toolCalls || [])];
              const last = toolCalls[toolCalls.length - 1];
              if (last) {
                last.status = status;
                last.endTime = Date.now();
                last.output = typeof ev.result.output === 'string'
                  ? ev.result.output
                  : JSON.stringify(ev.result.output);
              }
              msgs[idx] = { ...msgs[idx], toolCalls };
              messagesRef.current = [...msgs];
            }
          }
          flushRender();
          break;
        }

        case 'turn_complete': {
          currentAssistantIdRef.current = null;
          setIsStreaming(false);
          const chain = currentThinkingChainRef.current;
          if (chain && assistantId) {
            thinkingChainsRef.current.set(assistantId, chain);
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
          const errorMsg = ev.error?.message || 'Unknown error';
          setErrors((prev) => [...prev, errorMsg]);
          // A stream error means the turn will never emit turn_complete, so we
          // must clear the streaming flag here — otherwise isStreaming stays
          // true forever and AppRoot's useInput guard swallows all subsequent
          // input (user can't type a second message).
          currentAssistantIdRef.current = null;
          currentThinkingChainRef.current = null;
          setIsStreaming(false);
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
    errors,
    totalTokensUsed,
    addMessage,
    setMessages,
  };
}
