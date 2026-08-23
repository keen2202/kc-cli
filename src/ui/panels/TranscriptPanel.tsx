/**
 * Transcript panel (audit round3 T25 phase 1) — the chat/messages slot of the
 * app frame.
 *
 * Panel-boundary extraction only: the panel receives everything it renders as
 * down-flowing props (messages, thinking chains, the imperative scroll handle,
 * the global tool-output toggle and the streaming flag) and delegates to the
 * existing ChatPanel. It owns no state, no stores, no event channels, and no
 * layout policy — Yoga still owns all measurement inside the Layout slot.
 *
 * Spec: docs/specs/audit-remediation-round3-spec.md §5-L2.
 */

import React from 'react';
import { ChatPanel } from '../components/ChatPanel';
import type { ChatScrollHandle } from '../components/ChatMessagesView.js';
import type { ChatMessage, ThinkingChain } from '../view-protocol';

interface TranscriptPanelProps {
  /** Conversation transcript (user/assistant/system bubbles + tool cards). */
  messages: ChatMessage[];
  /** Per-assistant-message thinking chains, keyed by message id. */
  thinkingChains?: Map<string, ThinkingChain>;
  /** Scroll handle wired to the focus stack's editor base layer. */
  scrollRef: React.MutableRefObject<ChatScrollHandle | null>;
  /** Global tool-output expansion toggle (Ctrl+O). */
  toolOutputExpanded: boolean;
  /** Whether an engine turn is in flight; drives ChatView's self-scoped tick. */
  isStreaming: boolean;
}

export function TranscriptPanel({
  messages,
  thinkingChains,
  scrollRef,
  toolOutputExpanded,
  isStreaming,
}: TranscriptPanelProps) {
  return (
    <ChatPanel
      messages={messages}
      thinkingChains={thinkingChains}
      scrollRef={scrollRef}
      toolOutputExpanded={toolOutputExpanded}
      isStreaming={isStreaming}
    />
  );
}
