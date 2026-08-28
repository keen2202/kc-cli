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
import { useNowTick } from '../hooks/useNowTick';
import { computeOpenCodeLayout, getFrameHeight } from '../layout';

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

/** Left gutter applied to every content row so a message body lines up neatly
 *  under its role marker (keeps thinking / prose / tool cards on one column). */
const BODY_INDENT = '  ';

/** Wrap `text` to the indented body width and push each row with the gutter,
 *  preserving "1 array element = 1 terminal row" for the virtual scroller. */
function pushBody(out: string[], text: string, width: number): void {
  for (const line of wrapToWidth(text, Math.max(1, width - BODY_INDENT.length))) {
    out.push(BODY_INDENT + line);
  }
}

/**
 * Render one chat message into terminal rows (pure).
 *
 * Module-private (audit round3 T11): the "exported for tests" claim was stale
 * — no test imports it; both call sites below are in this file.
 *
 * Every turn opens with a role marker so a user question is unmistakable and
 * clearly set apart from the assistant's reply; the message body is then
 * indented one gutter under that marker so thinking chains, prose and tool
 * cards all align on a single column. A trailing blank row separates
 * consecutive messages.
 */
function renderMessageLines(
  message: ChatMessage,
  thinkingChain: ThinkingChain | undefined,
  tokens: ThemeTokens,
  width: number,
  toolOutputExpanded: boolean,
  now?: number,
): string[] {
  const lines: string[] = [];

  if (message.role === 'user') {
    // Prominent question marker: a solid left bar + "You" label in the user
    // accent colour so submitted questions stand out from replies at a glance.
    lines.push(tokens['chat.user']('▌ You'));
    if (message.content) {
      pushBody(lines, message.content, width);
    }
  } else if (message.role === 'assistant') {
    // Reply marker in the assistant accent colour, mirroring the user marker so
    // the two sides of the conversation are visually distinct.
    lines.push(tokens['chat.assistant']('● kc'));
    if (thinkingChain) {
      pushBody(lines, renderThinkingChain(thinkingChain, tokens, { expanded: toolOutputExpanded }), width);
    }
    if (message.content) {
      for (const line of renderMarkdown(message.content, undefined, Math.max(1, width - BODY_INDENT.length))) {
        pushBody(lines, line, width);
      }
    }
    for (const tc of message.toolCalls ?? []) {
      pushBody(lines, renderToolCallCard(tc, undefined, { expanded: toolOutputExpanded, now }), width);
    }
  } else {
    // system message: dim, no marker (informational, not part of the dialogue).
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

/** One pre-wrapped terminal row with a reconciliation key that is stable
 *  across scrolling and ticking: `<message id>:<row offset within message>`. */
interface ChatRowData {
  key: string;
  text: string;
}

/**
 * Test-only probe: counts how many times the history (all messages except the
 * last) is re-flattened, and how often the panel renders at all. Streaming
 * delta flushes must NOT re-flatten history — guarded by
 * test/ui/behavior/streaming-recompute.test.tsx.
 */
export const chatViewRenderStats = { historyFlattenCount: 0, renderCount: 0 };

const EMPTY_HISTORY: ChatMessage[] = [];

/**
 * Reference-stable history slice: returns the PREVIOUS array as long as no
 * message object identity changed. The streaming tail mutates only the newest
 * message, so a fresh `messages.slice(0, -1)` array (a new identity every
 * flush) would invalidate the history-rows memo and re-wrap the whole
 * transcript per flush — the pointer-compare here keeps it cached.
 */
function useStableHistory(messages: ChatMessage[]): ChatMessage[] {
  const cacheRef = useRef<{ history: ChatMessage[] }>({ history: EMPTY_HISTORY });
  const history = messages.length > 1 ? messages.slice(0, -1) : EMPTY_HISTORY;
  const cached = cacheRef.current.history;
  if (cached !== history) {
    if (
      cached.length === history.length &&
      cached.every((m, i) => m === history[i])
    ) {
      return cached;
    }
    cacheRef.current = { history };
  }
  return history;
}

/** Memoized row: unchanged rows skip re-rendering while the streaming clock
 *  ticks the panel every second. */
const ChatRow = React.memo(function ChatRow({ text }: { text: string }) {
  return <Text wrap="truncate-end">{text === '' ? ' ' : text}</Text>;
});

interface ChatViewProps {
  messages: ChatMessage[];
  thinkingChains?: Map<string, ThinkingChain>;
  /** Populated with scroll callbacks; ←/→ and PgUp/PgDn are dispatched by the focus stack's base layer. */
  scrollRef?: React.MutableRefObject<ChatScrollHandle | null>;
  /** Global tool-output expansion toggle (Ctrl+O). */
  toolOutputExpanded?: boolean;
  /** Whether an engine turn is in flight; drives a self-scoped 1s tick for the
   *  live spinner/elapsed on running tool cards (kept local so the clock never
   *  re-renders the whole app tree). */
  isStreaming?: boolean;
}

export const ChatView = React.memo(function ChatView({ messages, thinkingChains, scrollRef, toolOutputExpanded = false, isStreaming = false }: ChatViewProps) {
  chatViewRenderStats.renderCount++;
  const { tokens } = useTheme();
  const { height: termHeight, width: termWidth } = useTerminalSize();
  // Live wall-clock tick, scoped to this panel: only ticks while a turn is
  // streaming, so completed transcripts stay perfectly still (no flicker).
  const now = useNowTick(isStreaming);

  // Self-measure the rows/columns Yoga actually allotted (same pattern as
  // SidebarPanel): until the first measurement lands, fall back to a bound
  // derived from the layout POLICY (frame minus header/status/editor) instead
  // of raw constants — the old `termHeight - 8` guess over-wrapped whenever
  // the sidebar or editor took more than the assumed few rows.
  const rootRef = useRef<DOMElement | null>(null);
  const [measured, setMeasured] = useState<{ rows: number; cols: number } | null>(null);
  useEffect(() => {
    if (!rootRef.current) return;
    const { height: rows, width: cols } = measureElement(rootRef.current);
    if (rows > 0 && cols > 0 && (measured?.rows !== rows || measured?.cols !== cols)) {
      setMeasured({ rows, cols });
    }
  });
  const frameHeight = getFrameHeight(termHeight);
  const policy = computeOpenCodeLayout(termWidth, frameHeight);
  const rows = measured?.rows ?? Math.max(
    1,
    frameHeight - policy.headerHeight - policy.statusBarHeight - policy.editorHeight - 1,
  );
  const cols = measured?.cols ?? Math.max(20, termWidth - policy.rightPanelWidth - 2);

  // Flatten messages into pre-wrapped terminal rows. The wall-clock `now` only
  // affects live tool-card clocks, which can only exist on the newest message —
  // so history is flattened WITHOUT `now` and stays cached across clock ticks
  // AND across streaming tail flushes (useStableHistory keeps the array
  // identity while only the newest message mutates).
  const historyMessages = useStableHistory(messages);
  const lastMessage = messages.length > 0 ? messages[messages.length - 1] : undefined;

  const historyRows = useMemo(() => {
    chatViewRenderStats.historyFlattenCount++;
    const out: ChatRowData[] = [];
    for (const msg of historyMessages) {
      const rendered = renderMessageLines(msg, thinkingChains?.get(msg.id), tokens, cols, toolOutputExpanded);
      for (let j = 0; j < rendered.length; j++) {
        out.push({ key: `${msg.id}:${j}`, text: rendered[j] });
      }
    }
    return out;
  }, [historyMessages, thinkingChains, tokens, cols, toolOutputExpanded]);

  const lastRows = useMemo(() => {
    if (!lastMessage) return [] as ChatRowData[];
    const rendered = renderMessageLines(lastMessage, thinkingChains?.get(lastMessage.id), tokens, cols, toolOutputExpanded, now);
    return rendered.map((text, j) => ({ key: `${lastMessage.id}:${j}`, text }));
  }, [lastMessage, thinkingChains, tokens, cols, toolOutputExpanded, now]);

  const lines = useMemo(() => {
    const out = [...historyRows, ...lastRows];
    // Drop the trailing separator so the newest real row sits on the bottom edge.
    while (out.length > 0 && out[out.length - 1].text === '') out.pop();
    return out;
  }, [historyRows, lastRows]);

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
      {visible.map((row) => (
        <ChatRow key={row.key} text={row.text} />
      ))}
      {hiddenBelow > 0 && (
        <Text dimColor wrap="truncate-end">
          ↓ {hiddenBelow} more line{hiddenBelow === 1 ? '' : 's'} — →/PgDn to follow
        </Text>
      )}
    </Box>
  );
});
