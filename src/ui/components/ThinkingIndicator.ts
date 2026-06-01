import type { Theme } from '../theme';

export interface ThinkingIndicatorProps {
  startTime: number;
  theme: Theme;
}

export function renderThinkingIndicator(props: ThinkingIndicatorProps): string {
  const elapsed = ((Date.now() - props.startTime) / 1000).toFixed(1);
  const tokens = props.theme.resolve();
  return tokens['chat.assistant'](`Thinking... ${elapsed}s`);
}
