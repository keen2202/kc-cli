// LIVE (T7 triage): renderMarkdown is the markdown-to-ANSI pipeline used by
// ChatMessagesView on the live render path. Pure string logic — no ink here.
import chalk from 'chalk';
import { createRequire } from 'node:module';
import type { Theme } from '../theme';

// ESM-compatible require for lazy loading highlight.js (CommonJS module)
const require = createRequire(import.meta.url);

/** Map highlight.js token types to theme syntax colors. */
const TOKEN_COLOR_MAP: Record<string, keyof import('../theme').ThemeSyntax> = {
  'keyword': 'keyword',
  'built_in': 'keyword',
  'type': 'keyword',
  'literal': 'keyword',
  'number': 'number',
  'string': 'string',
  'regexp': 'string',
  'char': 'string',
  'comment': 'comment',
  'meta': 'comment',
  'function': 'function',
  'title': 'function',
  'params': 'function',
};

let _hljs: any = null;
let _hljsLoadFailed = false;

function getHighlightLang(): any {
  if (!_hljs && !_hljsLoadFailed) {
    try {
      _hljs = require('highlight.js');
    } catch {
      _hljsLoadFailed = true;
    }
  }
  return _hljs;
}

/**
 * Syntax-highlight a code block using highlight.js tokens mapped to ANSI.
 */
function highlightCode(code: string, language?: string, theme?: Theme): string {
  const hljs = getHighlightLang();
  if (!hljs) return chalk.gray(code);

  const syntaxColors = theme?.syntax;
  const defaultColor = chalk.white;

  try {
    let result: { tokens?: Array<{ types: string[]; content: string }>; value: string };

    if (language && hljs.getLanguage(language)) {
      result = hljs.highlight(code, { language });
    } else {
      result = hljs.highlightAuto(code);
    }

    // If tokens are available, map them to ANSI colors
    if (result.tokens && Array.isArray(result.tokens)) {
      return result.tokens.map(token => {
        const typeKey = token.types[0] ?? '';
        const colorKey = TOKEN_COLOR_MAP[typeKey];
        if (colorKey && syntaxColors) {
          const color = syntaxColors[colorKey];
          return chalk.hex(color)(token.content);
        }
        return token.content;
      }).join('');
    }

    // Fallback to plain text
    return code;
  } catch {
    return chalk.gray(code);
  }
}

/**
 * Render markdown text into ANSI-formatted output.
 */
export function renderMarkdown(text: string, theme?: Theme, maxWidth: number = 80): string[] {
  if (!text) return [];

  const lines = text.split('\n');
  const result: string[] = [];
  let inCodeBlock = false;
  let codeLanguage = '';
  let codeLines: string[] = [];
  const muted = chalk.gray;
  const themeMuted = theme ? chalk.hex(theme.colors.muted) : chalk.gray;

  for (const rawLine of lines) {
    // Fenced code block
    if (rawLine.trimStart().startsWith('```')) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeLanguage = rawLine.trimStart().slice(3).trim();
        codeLines = [];
        continue;
      } else {
        // End code block
        inCodeBlock = false;
        result.push(renderCodeBlockFrame(codeLines.join('\n'), codeLanguage, theme, maxWidth));
        codeLines = [];
        continue;
      }
    }

    if (inCodeBlock) {
      codeLines.push(rawLine);
      continue;
    }

    // Horizontal rule
    if (rawLine.trim() === '---' || rawLine.trim() === '___' || rawLine.trim() === '***') {
      result.push(themeMuted('─'.repeat(Math.min(maxWidth, 60))));
      continue;
    }

    // Blockquote
    if (rawLine.trimStart().startsWith('> ')) {
      const content = rawLine.trimStart().slice(2);
      result.push(themeMuted('│ ') + renderInlineMarkdown(content, theme));
      continue;
    }

    // Unordered list item
    const ulMatch = rawLine.match(/^(\s{0,4})[-*+]\s+(.+)/);
    if (ulMatch) {
      const indent = '  '.repeat(Math.floor((ulMatch[1]?.length ?? 0) / 2));
      result.push(indent + muted('• ') + renderInlineMarkdown(ulMatch[2]!, theme));
      continue;
    }

    // Ordered list item
    const olMatch = rawLine.match(/^(\s{0,4})\d+[.)]\s+(.+)/);
    if (olMatch) {
      const indent = '  '.repeat(Math.floor((olMatch[1]?.length ?? 0) / 2));
      result.push(indent + muted('• ') + renderInlineMarkdown(olMatch[2]!, theme));
      continue;
    }

    // Heading
    if (rawLine.startsWith('### ')) {
      result.push(chalk.bold.underline(renderInlineMarkdown(rawLine.slice(4), theme)));
      continue;
    }
    if (rawLine.startsWith('## ')) {
      result.push(chalk.bold.underline(renderInlineMarkdown(rawLine.slice(3), theme)));
      continue;
    }
    if (rawLine.startsWith('# ')) {
      result.push(chalk.bold.underline(renderInlineMarkdown(rawLine.slice(2), theme)));
      continue;
    }

    // Regular line
    result.push(renderInlineMarkdown(rawLine, theme));
  }

  // Close any dangling code block
  if (inCodeBlock && codeLines.length > 0) {
    result.push(renderCodeBlockFrame(codeLines.join('\n'), codeLanguage, theme, maxWidth));
  }

  return result;
}

/**
 * Render inline markdown formatting (bold, italic, code, links).
 */
function renderInlineMarkdown(text: string, theme?: Theme): string {
  if (!text) return '';

  const syntaxColors = theme?.syntax;
  const linkColor = theme ? chalk.hex(theme.colors.highlight).underline : chalk.blue.underline;
  const codeColor = theme ? chalk.hex(theme.colors.highlight) : chalk.yellow;

  // Process in order: code spans first (they override other formatting), then bold, then italic, then links
  let result = text;

  // Inline code: `code`
  result = result.replace(/`([^`]+)`/g, (_, code) => codeColor(code));

  // Bold: **text** or __text__
  result = result.replace(/\*\*(.+?)\*\*/g, (_, t) => chalk.bold(t));
  result = result.replace(/__(.+?)__/g, (_, t) => chalk.bold(t));

  // Italic: *text* or _text_ (but not inside words for _)
  result = result.replace(/\*(.+?)\*/g, (_, t) => chalk.italic(t));
  result = result.replace(/(?:^|\s)_(.+?)_(?:\s|$)/g, (_, t) => chalk.italic(t));

  // Links: [text](url)
  result = result.replace(/\[(.+?)\]\((.+?)\)/g, (_, label) => linkColor(label));

  return result;
}

/**
 * Render a fenced code block with a border frame and syntax highlighting.
 */
function renderCodeBlockFrame(code: string, language: string, theme?: Theme, maxWidth: number = 80): string {
  const highlighted = highlightCode(code, language || undefined, theme);
  const lines = highlighted.split('\n');
  const blockWidth = Math.min(maxWidth - 4, 70);

  const borderColor = theme ? chalk.hex(theme.colors.border) : chalk.gray;
  const mutedColor = theme ? chalk.hex(theme.colors.muted) : chalk.gray;

  const output: string[] = [];

  // Top border with language label
  const langLabel = language ? ` ${language} ` : ' code ';
  const topBar = '─'.repeat(Math.max(0, blockWidth - langLabel.length));
  output.push(borderColor('┌' + langLabel + topBar + '┐'));

  // Code lines (trimmed to fit)
  for (const line of lines) {
    const trimmed = line.length > blockWidth ? line.slice(0, blockWidth - 1) + '…' : line;
    const padding = ' '.repeat(Math.max(0, blockWidth - stripAnsiLen(trimmed)));
    output.push(borderColor('│') + ' ' + trimmed + padding + ' ' + borderColor('│'));
  }

  // Bottom border
  output.push(borderColor('└' + '─'.repeat(blockWidth) + '┘'));

  return output.join('\n');
}

function stripAnsiLen(str: string): number {
  return str.replace(/\x1B\[[0-9;]*m/g, '').length;
}
