import type { ThemeTokens } from '../theme';

// LIVE runtime helper (T7 triage): renderThinkingChain is used by
// ChatMessagesView. Data contracts (ThinkingChain et al.) live in
// view-protocol — import them from there, never from this file.
import type { ThinkingChain } from '../view-protocol';

/**
 * Render a thinking chain as a foldable tree in the terminal.
 */
export function renderThinkingChain(
  chain: ThinkingChain,
  tokens: ThemeTokens,
): string {
  const duration = ((Date.now() - chain.startTime) / 1000).toFixed(1);
  const stepCount = chain.steps.length;
  const header = tokens['thinking.folded'](`... Thinking (${stepCount} step${stepCount !== 1 ? 's' : ''}, ${duration}s)`);

  if (chain.folded) {
    return header;
  }

  const lines: string[] = [header];

  for (const step of chain.steps) {
    const labelTag = tokens['thinking.step'](`[${step.label}]`);
    // Truncate long content to keep terminal manageable
    const maxLen = 120;
    const content = step.content.length > maxLen
      ? step.content.slice(0, maxLen) + '...'
      : step.content;
    lines.push(`  ${labelTag} ${tokens['thinking.content'](content)}`);
  }

  return lines.join('\n');
}
