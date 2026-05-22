import chalk from 'chalk';

let _bareMode = false;

// Auto-detect pipe: enable bare mode when stdout is not a TTY
if (process.stdout.isTTY === false) {
  _bareMode = true;
}

export function setBareMode(bare: boolean): void {
  _bareMode = bare;
}

export function isBareMode(): boolean {
  return _bareMode;
}

function getTerminalWidth(): number {
  return process.stdout.columns || 80;
}

export function formatTextDelta(text: string): string {
  if (_bareMode) return text;
  return text;
}

export function formatToolCall(toolName: string, input: Record<string, unknown>): string {
  if (_bareMode) {
    return `[Tool: ${toolName}] ${JSON.stringify(input)}`;
  }

  const inputStr = JSON.stringify(input, null, 2);
  const truncated = inputStr.length > 500 ? inputStr.slice(0, 500) + '...' : inputStr;

  return [
    '',
    chalk.yellow.bold(`Tool: ${toolName}`),
    chalk.gray(truncated),
  ].join('\n');
}

export function formatToolResult(output: string, isError: boolean = false): string {
  if (_bareMode) {
    return isError ? `[Error] ${output}` : `[Result] ${output}`;
  }

  const maxLen = 300;
  const truncated = output.length > maxLen ? output.slice(0, maxLen) + '...' : output;

  if (isError) {
    return chalk.red(`Error: ${truncated}`);
  }
  return chalk.green(`Done`) + chalk.gray(` — ${truncated}`);
}

export function formatDiff(filePath: string, oldContent: string, newContent: string): string {
  if (_bareMode) {
    return `[Diff: ${filePath}]`;
  }

  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');
  const maxLines = 30;

  const diffLines: string[] = [chalk.cyan.bold(`--- ${filePath}`)];

  const maxLen = Math.max(oldLines.length, newLines.length);
  let shown = 0;

  for (let i = 0; i < maxLen && shown < maxLines; i++) {
    const oldLine = oldLines[i];
    const newLine = newLines[i];

    if (oldLine !== newLine) {
      if (oldLine !== undefined) {
        diffLines.push(chalk.red(`- ${oldLine}`));
        shown++;
      }
      if (newLine !== undefined && shown < maxLines) {
        diffLines.push(chalk.green(`+ ${newLine}`));
        shown++;
      }
    }
  }

  if (maxLen > maxLines) {
    diffLines.push(chalk.gray(`... (${maxLen - maxLines} more lines)`));
  }

  return diffLines.join('\n');
}

export function formatSeparator(): string {
  if (_bareMode) return '---';
  return chalk.gray('─'.repeat(getTerminalWidth()));
}

export function formatBanner(version: string): string {
  if (_bareMode) {
    return `KC-CLI v${version}`;
  }

  return [
    chalk.cyan.bold('KC-CLI') + chalk.gray(` v${version}`),
    chalk.gray('Intelligent Agent System'),
  ].join('\n');
}

export function formatStatusLine(data: {
  provider?: string;
  model?: string;
  turnCount?: number;
  maxTurns?: number;
  tokensUsed?: number;
  sessionTime?: number;
}): string {
  if (_bareMode) return '';

  const parts: string[] = [];

  if (data.provider && data.model) {
    parts.push(chalk.cyan(`${data.provider}/${data.model}`));
  }

  if (data.turnCount !== undefined && data.maxTurns !== undefined) {
    const pct = Math.round((data.turnCount / data.maxTurns) * 100);
    const bar = renderProgressBar(pct, 10);
    parts.push(`${bar} ${data.turnCount}/${data.maxTurns} turns`);
  }

  if (data.tokensUsed !== undefined) {
    parts.push(chalk.gray(`${formatTokenCount(data.tokensUsed)} tokens`));
  }

  if (data.sessionTime !== undefined) {
    parts.push(chalk.gray(formatDuration(data.sessionTime)));
  }

  return parts.join(chalk.gray(' | '));
}

function renderProgressBar(percent: number, width: number): string {
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  return chalk.green('█'.repeat(filled)) + chalk.gray('░'.repeat(empty));
}

function formatTokenCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${minutes}m${secs}s`;
}

// Cached highlight.js module reference (lazy-loaded once)
let _hljs: any = null;
let _hljsLoadFailed = false;

export function formatCodeBlock(code: string, language?: string): string {
  if (_bareMode) return code;

  try {
    if (!_hljs && !_hljsLoadFailed) {
      _hljs = require('highlight.js');
    }
    if (!_hljs) return chalk.gray(code);

    if (language && _hljs.getLanguage(language)) {
      const highlighted = _hljs.highlight(code, { language }).value;
      return highlighted;
    }
    // Auto-detect language
    const highlighted = _hljs.highlightAuto(code).value;
    return highlighted;
  } catch {
    _hljsLoadFailed = true;
    return chalk.gray(code);
  }
}
