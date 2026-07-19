import chalk from 'chalk';
import { createRequire } from 'node:module';
import { isBareMode } from './formatter';
import type { Theme } from './theme';

// ESM-compatible require for lazy loading the diff library (CommonJS module)
const require = createRequire(import.meta.url);

/** Represents a single line in a diff. */
export interface DiffLine {
  type: 'add' | 'remove' | 'context';
  content: string;
  oldLineNum?: number;
  newLineNum?: number;
}

/** Represents a pending file change with old and new content. */
export interface FileDiff {
  /** Relative or absolute file path */
  filePath: string;
  /** Original file content (null for new files) */
  oldContent: string | null;
  /** New file content after edit */
  newContent: string;
  /** Whether the user has accepted this change */
  accepted: boolean;
  /** Whether the user has rejected this change */
  rejected: boolean;
}

export function computeDiff(oldText: string, newText: string): DiffLine[] {
  // Use the diff library for unified diff generation
  try {
    const diffLib = require('diff');
    const changes = diffLib.diffLines(oldText, newText);
    const result: DiffLine[] = [];
    let oldLineNum = 1;
    let newLineNum = 1;

    for (const part of changes) {
      const lines = part.value.split('\n');
      // diffLines may produce a trailing empty string from split
      if (lines[lines.length - 1] === '') lines.pop();

      for (const line of lines) {
        if (part.added) {
          result.push({ type: 'add', content: line, newLineNum: newLineNum++ });
        } else if (part.removed) {
          result.push({ type: 'remove', content: line, oldLineNum: oldLineNum++ });
        } else {
          result.push({ type: 'context', content: line, oldLineNum: oldLineNum++, newLineNum: newLineNum++ });
        }
      }
    }

    return result;
  } catch (_err) {
      console.error("Suppressed error:", _err);
    // Fallback to manual line-by-line comparison if diff library not available
    return computeDiffManual(oldText, newText);
  }
}

function computeDiffManual(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const result: DiffLine[] = [];

  const maxLen = Math.max(oldLines.length, newLines.length);

  for (let i = 0; i < maxLen; i++) {
    const oldLine = oldLines[i];
    const newLine = newLines[i];

    if (oldLine === newLine) {
      if (oldLine !== undefined) {
        result.push({
          type: 'context',
          content: oldLine,
          oldLineNum: i + 1,
          newLineNum: i + 1,
        });
      }
    } else {
      if (oldLine !== undefined) {
        result.push({
          type: 'remove',
          content: oldLine,
          oldLineNum: i + 1,
        });
      }
      if (newLine !== undefined) {
        result.push({
          type: 'add',
          content: newLine,
          newLineNum: i + 1,
        });
      }
    }
  }

  return result;
}

/**
 * Render a multi-file diff preview with file tabs and action bar.
 * Used for inline display in the chat area after FileWrite/FileEdit.
 */
export function renderMultiFileDiff(
  diffs: FileDiff[],
  activeIndex: number = 0,
  options: { maxWidth?: number; maxLines?: number; theme?: Theme } = {}
): string {
  const tokens = options.theme?.resolve();
  const maxWidth = options.maxWidth ?? 80;
  const maxLines = options.maxLines ?? 20;
  const lines: string[] = [];

  if (diffs.length === 0) {
    lines.push(chalk.gray.dim('  No pending changes.'));
    return lines.join('\n');
  }

  const activeDiff = diffs[activeIndex];
  if (!activeDiff) return '';

  const diffData = computeDiff(activeDiff.oldContent || '', activeDiff.newContent);
  // Single-pass count instead of two filter() calls
  let adds = 0;
  let removes = 0;
  for (let i = 0; i < diffData.length; i++) {
    if (diffData[i].type === 'add') adds++;
    else if (diffData[i].type === 'remove') removes++;
  }

  // ── Header ──
  const borderColor = tokens ? tokens['overlay.border'] : chalk.gray;
  const headerColor = tokens ? tokens['overlay.selected'] : chalk.cyan.bold;
  lines.push(
    borderColor('┌─ ') +
    headerColor('Diff Preview') +
    borderColor(` (${activeIndex + 1}/${diffs.length})`) +
    borderColor(' ─' + '─'.repeat(Math.min(maxWidth - 28, 40)) + '┐')
  );

  // ── File tabs (multi-file) ──
  if (diffs.length > 1) {
    const tabLines: string[] = [];
    for (let i = 0; i < diffs.length; i++) {
      const d = diffs[i];
      const fileName = d.filePath.split('/').pop() || d.filePath;
      const changeCount = d.accepted ? '✓' : d.rejected ? '✗' : `+${adds} -${removes}`;
      if (i === activeIndex) {
        tabLines.push(chalk.cyan.bold(`  [${i + 1}] ${fileName} (${changeCount})`));
      } else {
        tabLines.push(chalk.gray.dim(`   ${i + 1}. ${fileName} (${changeCount})`));
      }
    }
    lines.push(...tabLines);
    lines.push('');
  }

  // ── File info ──
  const statusLabel = activeDiff.oldContent === null
    ? chalk.green(' (new file)')
    : activeDiff.accepted
      ? chalk.green(' (accepted)')
      : activeDiff.rejected
        ? chalk.red(' (rejected)')
        : '';
  lines.push(chalk.gray('  File: ') + chalk.bold(activeDiff.filePath) + statusLabel);
  lines.push(chalk.gray('  ' + '─'.repeat(Math.min(maxWidth - 4, 60))));

  // ── Diff content ──
  const addColor = tokens ? tokens['diff.added'] : chalk.green;
  const removeColor = tokens ? tokens['diff.removed'] : chalk.red;
  const contextColor = tokens ? tokens['diff.context'] : chalk.gray;
  const shown = Math.min(diffData.length, maxLines);
  for (let i = 0; i < shown; i++) {
    const line = diffData[i];
    const lineNum = line.type === 'remove'
      ? String(line.oldLineNum || '').padStart(4)
      : String(line.newLineNum || '').padStart(4);

    const contentWidth = Math.max(0, maxWidth - 14);
    const content = line.content.length > contentWidth
      ? line.content.slice(0, contentWidth - 1) + '…'
      : line.content;

    switch (line.type) {
      case 'add':
        lines.push(addColor(`  + ${lineNum} │ ${content}`));
        break;
      case 'remove':
        lines.push(removeColor(`  - ${lineNum} │ ${content}`));
        break;
      default:
        lines.push(contextColor(`    ${lineNum} │ ${content}`));
    }
  }

  if (diffData.length > maxLines) {
    lines.push(chalk.gray(`  ... (${diffData.length - maxLines} more lines)`));
  }

  // ── Action bar ──
  lines.push(chalk.gray('  ' + '─'.repeat(Math.min(maxWidth - 4, 60))));
  if (!activeDiff.accepted && !activeDiff.rejected) {
    lines.push(chalk.gray.dim('  [A]ccept  [R]eject  [←/→] Switch file  [Q]uit'));
  } else {
    lines.push(chalk.gray.dim('  [←/→] Switch file  [Q]uit'));
  }

  return lines.join('\n');
}

export function renderDiffLines(lines: DiffLine[], maxLines: number = 50, theme?: Theme): string {
  const tokens = theme?.resolve();
  if (isBareMode()) {
    return lines.slice(0, maxLines).map(l => {
      const prefix = l.type === 'add' ? '+' : l.type === 'remove' ? '-' : ' ';
      return `${prefix} ${l.content}`;
    }).join('\n');
  }

  const output: string[] = [];
  const shown = Math.min(lines.length, maxLines);

  for (let i = 0; i < shown; i++) {
    const line = lines[i];
    const lineNum = line.type === 'remove'
      ? String(line.oldLineNum || '').padStart(4)
      : String(line.newLineNum || '').padStart(4);

    const addC = tokens ? tokens['diff.added'] : chalk.green;
    const removeC = tokens ? tokens['diff.removed'] : chalk.red;
    const contextC = tokens ? tokens['diff.context'] : chalk.gray;

    switch (line.type) {
      case 'add':
        output.push(addC(`+ ${lineNum} │ ${line.content}`));
        break;
      case 'remove':
        output.push(removeC(`- ${lineNum} │ ${line.content}`));
        break;
      case 'context':
        output.push(contextC(`  ${lineNum} │ ${line.content}`));
        break;
    }
  }

  if (lines.length > maxLines) {
    output.push(chalk.gray(`... (${lines.length - maxLines} more lines)`));
  }

  return output.join('\n');
}
