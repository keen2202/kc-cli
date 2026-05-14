import chalk from 'chalk';
import { isBareMode } from './formatter';

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
  } catch {
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
  options: { maxWidth?: number; maxLines?: number } = {}
): string {
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
  const adds = diffData.filter(l => l.type === 'add').length;
  const removes = diffData.filter(l => l.type === 'remove').length;

  // ── Header ──
  lines.push(
    chalk.gray('┌─ ') +
    chalk.cyan.bold('Diff Preview') +
    chalk.gray(` (${activeIndex + 1}/${diffs.length})`) +
    chalk.gray(' ─' + '─'.repeat(Math.min(maxWidth - 28, 40)) + '┐')
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
        lines.push(chalk.green(`  + ${lineNum} │ ${content}`));
        break;
      case 'remove':
        lines.push(chalk.red(`  - ${lineNum} │ ${content}`));
        break;
      default:
        lines.push(chalk.gray(`    ${lineNum} │ ${content}`));
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

export function renderDiffLines(lines: DiffLine[], maxLines: number = 50): string {
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

    switch (line.type) {
      case 'add':
        output.push(chalk.green(`+ ${lineNum} │ ${line.content}`));
        break;
      case 'remove':
        output.push(chalk.red(`- ${lineNum} │ ${line.content}`));
        break;
      case 'context':
        output.push(chalk.gray(`  ${lineNum} │ ${line.content}`));
        break;
    }
  }

  if (lines.length > maxLines) {
    output.push(chalk.gray(`... (${lines.length - maxLines} more lines)`));
  }

  return output.join('\n');
}
