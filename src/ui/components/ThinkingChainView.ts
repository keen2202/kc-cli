import type { ThemeTokens } from '../theme';

// LIVE runtime helper (T7 triage): renderThinkingChain is used by
// ChatMessagesView. Data contracts (ThinkingChain et al.) live in
// view-protocol — import them from there, never from this file.
import type { ThinkingChain } from '../view-protocol';

/** Rendering options for the thinking chain. */
export interface ThinkingChainOptions {
  /** When true (Ctrl+O), show every step's full content regardless of chain.folded. */
  expanded?: boolean;
}

/** Expanded chains cap the rendered rows to avoid flooding the terminal. */
const EXPANDED_MAX_LINES = 200;

/**
 * Render a thinking chain as a foldable tree in the terminal.
 *
 * Two states:
 *  - streaming (no endTime): header with a live timer plus a one-line preview
 *    of the latest step, so long reasoning phases show visible progress;
 *  - completed (endTime set): folded header with the duration frozen.
 *
 * The global expand toggle (Ctrl+O) overrides chain.folded so completed
 * reasoning is inspectable after the fact.
 */
export function renderThinkingChain(
  chain: ThinkingChain,
  tokens: ThemeTokens,
  options?: ThinkingChainOptions,
): string {
  const expanded = options?.expanded ?? false;
  const endedAt = chain.endTime ?? Date.now();
  const duration = (Math.max(0, endedAt - chain.startTime) / 1000).toFixed(1);
  const stepCount = chain.steps.length;
  const hint = !expanded && stepCount > 0 ? ' · Ctrl+O to expand' : '';
  const header = tokens['thinking.folded'](`... Thinking (${stepCount} step${stepCount !== 1 ? 's' : ''}, ${duration}s)${hint}`);
  const streaming = chain.endTime === undefined;

  if (chain.folded && !expanded) {
    if (!streaming) {
      return header;
    }
    // While streaming, surface the newest step's content as a single truncated
    // line under the header so the user sees reasoning progress live.
    const latest = chain.steps[chain.steps.length - 1];
    if (!latest) {
      return header;
    }
    const maxLen = 100;
    const oneLine = latest.content.replace(/\s+/g, ' ').trim();
    const preview = oneLine.length > maxLen ? oneLine.slice(0, maxLen) + '...' : oneLine;
    const labelTag = tokens['thinking.step'](`[${latest.label}]`);
    return `${header}\n  ${labelTag} ${tokens['thinking.content'](preview)}`;
  }

  const lines: string[] = [header];

  for (const step of chain.steps) {
    const labelTag = tokens['thinking.step'](`[${step.label}]`);
    if (expanded) {
      // Full content: emit every line of the step (downstream wrapping handles
      // width); cap the total to keep the terminal manageable.
      const stepLines = step.content.replace(/\r\n/g, '\n').split('\n');
      lines.push(`  ${labelTag} ${tokens['thinking.content'](stepLines[0] ?? '')}`);
      for (const extra of stepLines.slice(1)) {
        lines.push(`  ${tokens['thinking.content'](extra)}`);
      }
      if (lines.length >= EXPANDED_MAX_LINES) {
        lines.length = EXPANDED_MAX_LINES;
        lines.push(tokens['thinking.content']('  … truncated'));
        break;
      }
    } else {
      // Truncate long content to keep terminal manageable
      const maxLen = 120;
      const content = step.content.length > maxLen
        ? step.content.slice(0, maxLen) + '...'
        : step.content;
      lines.push(`  ${labelTag} ${tokens['thinking.content'](content)}`);
    }
  }

  return lines.join('\n');
}
