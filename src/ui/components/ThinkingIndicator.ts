import type { Theme } from '../theme';

export interface ThinkingIndicatorProps {
  startTime: number;
  theme: Theme;
  stepCount?: number;
  folded?: boolean;
}

export function renderThinkingIndicator(props: ThinkingIndicatorProps): string {
  const elapsed = ((Date.now() - props.startTime) / 1000).toFixed(1);
  const tokens = props.theme.resolve();

  if (props.stepCount !== undefined && props.stepCount > 0) {
    const foldHint = props.folded !== false ? ' (press t to expand)' : '';
    return tokens['thinking.label'](`Thinking... ${elapsed}s (${props.stepCount} steps)${foldHint}`);
  }

  return tokens['chat.assistant'](`Thinking... ${elapsed}s`);
}
