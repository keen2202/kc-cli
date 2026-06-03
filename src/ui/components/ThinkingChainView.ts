import type { ThemeTokens } from '../theme';

export type ThinkingStepLabel = 'analyze' | 'decide' | 'plan' | 'execute' | 'think';

export interface ThinkingStep {
  label: ThinkingStepLabel;
  content: string;
}

export interface ThinkingChain {
  steps: ThinkingStep[];
  rawContent: string;
  folded: boolean;
  startTime: number;
}

/**
 * Classify raw thinking text into structured steps by keyword heuristics.
 * Returns steps with labels based on content patterns.
 */
export function classifyThinkingSteps(raw: string): ThinkingStep[] {
  // Split on paragraph boundaries or sentence boundaries for step detection
  const segments = raw.split(/\n{2,}|(?<=\.)\s+/).filter(s => s.trim().length > 0);
  const steps: ThinkingStep[] = [];

  for (const segment of segments) {
    const lower = segment.toLowerCase();
    let label: ThinkingStepLabel = 'think';

    if (/analyz|look at|examin|consider|review|check/.test(lower)) {
      label = 'analyze';
    } else if (/decid|choos|select|pick|determin/.test(lower)) {
      label = 'decide';
    } else if (/plan|step|first|then|next|approach|strateg/.test(lower)) {
      label = 'plan';
    } else if (/execut|run|call|use|apply|perform/.test(lower)) {
      label = 'execute';
    }

    steps.push({ label, content: segment.trim() });
  }

  return steps.length > 0 ? steps : [{ label: 'think', content: raw }];
}

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
