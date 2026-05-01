// Chalk-based renderer - entry point for the terminal UI

import type { QueryEngine } from '../query/QueryEngine';
import { runApp } from './components/App';

interface RenderOptions {
  queryEngine: QueryEngine;
  provider?: string;
  model?: string;
  maxTurns?: number;
}

export function renderInkUI(options: RenderOptions): void {
  runApp({
    queryEngine: options.queryEngine,
    provider: options.provider,
    model: options.model,
    maxTurns: options.maxTurns,
  }).catch((error) => {
    console.error('UI error:', error);
    process.exit(1);
  });
}
