import React, { useMemo, useRef, useEffect, useState } from 'react';
import { Box, Text, measureElement, type DOMElement } from 'ink';
import chalk from 'chalk';
import wrapAnsi from 'wrap-ansi';
import type { ChatMessage, ThinkingChain } from '../view-protocol';
import type { ThemeTokens } from '../theme';
import { renderThinkingChain } from './ThinkingChainView';
import { renderToolCallCard } from './ToolCallCard';
import { renderMarkdown } from './MarkdownRenderer';
import { useTheme } from '../hooks/useTheme';
import { useTerminalSize } from '../hooks/useTerminalSize';

// ── Line-accurate rendering ──
//
// Scrolling correctness requires "1 array element = 1 terminal row". Every
// message is rendered through the existing string pipelines (markdown,
// thinking chain, tool cards) and then pre-wrapped to the measured viewport
// width with wrap-ansi, so the visible window can be sliced by real rows
// instead of a per-message height estimate.

/** Wrap a (possibly multi-line, ANSI-styled) string to `width` columns. */
function wrapToWidth(text: string, width: number): string[] {
  if (width <= 0) return text.split('\n');
  return wrapAnsi(text, width, { hard: true, trim: false }).split('\n');
}

/**
 * Render one chat message into terminal rows (pure; exported for tests).
 * A trailing blank row separates consecutive messages.
 */
export function renderMessageLines(
  message: ChatMessage,
  thinkingChain: ThinkingChain | undefined,
  tokens: ThemeTokens,
  width: number,
  toolOutputExpanded: boolean,
): string[] {
  const lines: string[] = [];

  if (message.role === 'user') {
    lines.push(...wrapToWidth(tokens['chat.user']('▸ ') + (message.content ?? ''), width));
  } else if (message.role === 'assistant') {
    if (thinkingChain) {
      lines.push(...wrapToWidth(renderThinkingChain(thinkingChain, tokens), width));
    }
    if (message.content) {
      for (const line of renderMarkdown(message.content, undefined, width)) {
        lines.push(...wrapToWidth(line, width));
      }
    }
    for (const tc of message.toolCalls ?? []) {
      lines.push(...wrapToWidth(renderToolCallCard(tc, undefined, { expanded: toolOutputExpanded }), width));
    }
  } else {
    // system message
    lines.push(...wrapToWidth(chalk.gray(message.content ?? ''), width));
  }

  lines.push('');
  return lines;
}

/** Imperative scroll handle exposed to the editor base focus layer. */
export interface ChatScrollHandle {
  scrollLineUp: () => void;
  scrollLineDown: () => void;
  scrollPageUp: () => void;
  scrollPageDown: () => void;
}

interface ChatViewProps {
  messages: ChatMessage[];
  thinkingChains?: Map<string, ThinkingChain>;
  /** Populated with scroll callbacks; ←/→ and PgUp/PgDn are dispatched by the focus stack's base layer. */
  scrollRef?: React.MutableRefObject<ChatScrollHandle | null>;
  /** Global tool-output expansion toggle (Ctrl+O). */
  toolOutputExpanded?: boolean;
}

export function ChatView({ messages, thinkingChains, scrollRef, toolOutputExpanded = false }: ChatViewProps) {
  const { tokens } = useTheme();
  const { height: termHeight, width: termWidth } = useTerminalSize();

  // Self-measure the rows/columns Yoga actually allotted (same pattern as
  // SidebarPanel): until the first measurement lands, fall back to a
  // conservative bound derived from the terminal size.
  const rootRef = useRef<DOMElement | null>(null);
  const [measured, setMeasured] = useState<{ rows: number; cols: number } | null>(null);
  useEffect(() => {
    if (!rootRef.current) return;
    const { height: rows, width: cols } = measureElement(rootRef.current);
    if (rows > 0 && cols > 0 && (measured?.rows !== rows || measured?.cols !== cols)) {
      setMeasured({ rows, cols });
    }
  });
  const rows = measured?.rows ?? Math.max(4, termHeight - 8);
  const cols = measured?.cols ?? Math.max(20, termWidth - 6);

  // Flatten all messages into pre-wrapped terminal rows.
  const lines = useMemo(() => {
    const out: string[] = [];
    for (const msg of messages) {
      out.push(...renderMessageLines(msg, thinkingChains?.get(msg.id), tokens, cols, toolOutputExpanded));
    }
    // Drop the trailing separator so the newest real row sits on the bottom edge.
    while (out.length > 0 && out[out.length - 1] === '') out.pop();
    return out;
  }, [messages, thinkingChains, tokens, cols, toolOutputExpanded]);

  const total = lines.length;

  // Scroll position measured in rows from the bottom. 0 = follow the tail
  // (auto-scroll during streaming); >0 = the user is reading history.
  const [offsetFromBottom, setOffsetFromBottom] = useState(0);

  // Handlers read live geometry through a ref so the scrollRef stays stable.
  const geometryRef = useRef({ total, rows });
  geometryRef.current = { total, rows };

  const clampOffset = (value: number): number => {
    const g = geometryRef.current;
    const maxOffset = Math.max(0, g.total - Math.max(1, g.rows - 2));
    return Math.max(0, Math.min(maxOffset, value));
  };

  // Keep the viewport anchored to the content the user is reading: when
  // scrolled up (offset > 0) and new rows append below, grow the offset by the
  // same amount so the view does not jump; at offset 0 keep following the tail.
  // This runs during render (derived-state pattern), NOT in an effect: a
  // passive effect can flush late and misattribute growth that happened
  // before a user scroll, catapulting the offset to the top of the history.
  const prevTotalRef = useRef(total);
  if (prevTotalRef.current !== total) {
    const delta = total - prevTotalRef.current;
    prevTotalRef.current = total;
    if (offsetFromBottom > 0) {
      const next = clampOffset(delta > 0 ? offsetFromBottom + delta : offsetFromBottom);
      if (next !== offsetFromBottom) setOffsetFromBottom(next);
    }
  }

  // Expose scrolling to the focus stack's editor base layer.
  useEffect(() => {
    if (!scrollRef) return;
    const page = () => Math.max(1, geometryRef.current.rows - 2);
    scrollRef.current = {
      scrollLineUp: () => setOffsetFromBottom((prev) => clampOffset(prev + 1)),
      scrollLineDown: () => setOffsetFromBottom((prev) => clampOffset(prev - 1)),
      scrollPageUp: () => setOffsetFromBottom((prev) => clampOffset(prev + page())),
      scrollPageDown: () => setOffsetFromBottom((prev) => clampOffset(prev - page())),
    };
    return () => {
      scrollRef.current = null;
    };
  }, [scrollRef]);

  // Viewport slice. Indicator rows are carved out of the same allotment so the
  // panel never exceeds its measured height.
  const offset = Math.min(offsetFromBottom, Math.max(0, total - 1));
  let avail = rows;
  const showBelow = offset > 0;
  if (showBelow) avail -= 1;
  const showAbove = total - offset > avail;
  if (showAbove) avail -= 1;
  avail = Math.max(1, avail);

  const end = total - offset;
  const start = Math.max(0, end - avail);
  const visible = lines.slice(start, end);
  const hiddenAbove = start;
  const hiddenBelow = offset;

  return (
    <Box ref={rootRef} flexDirection="column" flexGrow={1}>
      {showAbove && (
        <Text dimColor wrap="truncate-end">
          ↑ {hiddenAbove} more line{hiddenAbove === 1 ? '' : 's'} — ←/PgUp to scroll up
        </Text>
      )}
      {visible.map((line, i) => (
        <Text key={start + i} wrap="truncate-end">
          {line === '' ? ' ' : line}
        </Text>
      ))}
      {hiddenBelow > 0 && (
        <Text dimColor wrap="truncate-end">
          ↓ {hiddenBelow} more line{hiddenBelow === 1 ? '' : 's'} — →/PgDn to follow
        </Text>
      )}
    </Box>
  );
}
