import chalk from 'chalk';
import { isBareMode } from './formatter';

interface DiffLine {
  type: 'add' | 'remove' | 'context';
  content: string;
  oldLineNum?: number;
  newLineNum?: number;
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
