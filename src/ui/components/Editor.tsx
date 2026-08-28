import React, { useState, useRef, useEffect } from 'react';
import { Box, Text, measureElement, type DOMElement } from 'ink';
import { useTheme } from '../hooks/useTheme';
import { useTerminalSize } from '../hooks/useTerminalSize';
import { computeOpenCodeLayout, getFrameHeight } from '../layout';

interface Attachment {
  path: string;
  name: string;
}

interface EditorProps {
  text: string;
  cursorPos: number;
  isSteerMode?: boolean;
  attachments?: Attachment[];
  deleteMode?: boolean;
}

const MAX_ATTACHMENTS = 5;

/**
 * Keyboard shortcut hint bar shown at the top or bottom of the editor.
 * Lists the most common keybindings for quick reference.
 */
function KeyboardHints() {
  const { tokens } = useTheme();
  const hints = [
    { key: 'Enter', action: 'Submit' },
    { key: '^J/S-Enter', action: 'Newline' },
    { key: '^I', action: 'Steer' },
    { key: '^E', action: 'Editor' },
    { key: '^C', action: 'Quit' },
  ];

  return (
    <Box flexDirection="row" gap={1}>
      {hints.map((hint) => (
        <Text key={hint.key} dimColor>
          <Text bold>{hint.key}</Text>
          <Text>:{hint.action}</Text>
        </Text>
      ))}
    </Box>
  );
}

export function Editor({
  text,
  cursorPos,
  isSteerMode = false,
  attachments = [],
  deleteMode = false,
}: EditorProps) {
  const { tokens, colors } = useTheme();
  const { width, height } = useTerminalSize();
  const promptPrefix = isSteerMode ? 'steer> ' : 'kc> ';

  const attachmentCount = attachments.length;

  // Width truth: measure the columns Yoga actually allotted to this component.
  // The raw terminal width over-counts whenever the sidebar column is visible,
  // which let long input lines wrap past the border on narrow terminals.
  const rootRef = useRef<DOMElement | null>(null);
  const [measuredWidth, setMeasuredWidth] = useState<number | null>(null);
  useEffect(() => {
    if (!rootRef.current) return;
    const { width: w } = measureElement(rootRef.current);
    if (w > 0 && w !== measuredWidth) setMeasuredWidth(w);
  });

  // Height budget the editor is allotted by the layout. Content must fit
  // within this (minus the border) or it overflows and overlaps the chat
  // panel on small terminals. We progressively reveal chrome as room allows.
  // getFrameHeight mirrors Layout's frame (height-1) — deriving the budget
  // from the FULL terminal height was a one-row overshoot on tight screens.
  const { editorHeight } = computeOpenCodeLayout(width, getFrameHeight(height));
  const innerBudget = editorHeight - 2; // subtract top/bottom border rows
  const remaining = innerBudget - 1; // reserve one row for the input line
  const showHints = remaining >= 3; // hint bar needs ~3 rows (with margins)
  // Attachments row costs 1-2 rows: keep it while >=2 rows remain, or >=1 row
  // when attachments exist (the count is then the higher-value information).
  const showAttachmentBar = remaining >= 2 || (attachmentCount > 0 && remaining >= 1);
  const attachmentBarMargin = remaining >= 2 ? 1 : 0;
  const showAttachmentDetails = attachmentCount > 0 && remaining >= (showHints ? 5 : 2);

  // Columns available for input text: allotted width minus border+padding
  // and the prompt prefix. Pre-measurement fall back to the terminal width.
  const innerWidth = Math.max(10, (measuredWidth ?? width) - 4);
  const textCols = Math.max(4, innerWidth - promptPrefix.length);

  // Rows left for the input text once the visible chrome is accounted for.
  const chromeRows =
    (showHints ? 3 : 0) +
    (showAttachmentBar ? 1 + attachmentBarMargin : 0) +
    (showAttachmentDetails ? attachmentCount * 2 : 0);
  const inputRows = Math.max(1, innerBudget - chromeRows);

  const promptNode = isSteerMode
    ? tokens['input.steer'](promptPrefix)
    : tokens['input.prompt'](promptPrefix);

  // Build display text with cursor position indicator. Lines are clipped to
  // the measured column budget (cursor-following horizontal window on the
  // cursor line) and the line list to `inputRows`, so the editor never wraps
  // or grows past its allotment on narrow terminals.
  const renderInputLines = () => {
    if (text.length === 0) {
      return (
        <Text wrap="truncate">
          {promptNode}
          <Text backgroundColor="white" color="black"> </Text>
        </Text>
      );
    }

    // Locate the cursor's line/column in the (possibly multi-line) text.
    const lines = text.split('\n');
    let cursorLine = 0;
    let cursorCol = Math.min(cursorPos, text.length);
    for (let i = 0; i < lines.length; i++) {
      if (cursorCol <= lines[i].length) {
        cursorLine = i;
        break;
      }
      cursorCol -= lines[i].length + 1; // +1 for the newline
      cursorLine = i + 1;
    }
    if (cursorLine >= lines.length) {
      cursorLine = lines.length - 1;
      cursorCol = lines[cursorLine].length;
    }

    // Vertical window: show the last `inputRows` lines, shifted up if needed
    // so the cursor line is always visible.
    let endLine = lines.length;
    let startLine = Math.max(0, endLine - inputRows);
    if (cursorLine < startLine) {
      startLine = cursorLine;
      endLine = Math.min(lines.length, startLine + inputRows);
    }

    return lines.slice(startLine, endLine).map((line, i) => {
      const absoluteIdx = startLine + i;
      const prefix = i === 0 ? promptNode : ' '.repeat(promptPrefix.length);

      if (absoluteIdx !== cursorLine) {
        return (
          <Text key={absoluteIdx} wrap="truncate">
            {prefix}
            <Text>{line.slice(0, textCols)}</Text>
          </Text>
        );
      }

      // Cursor line: horizontal window that keeps the cursor in view. The
      // window ends at the cursor when it runs past the column budget.
      const winStart = cursorCol >= textCols ? cursorCol - textCols + 1 : 0;
      const visible = line.slice(winStart, winStart + textCols);
      const vCol = cursorCol - winStart;
      const beforeCursor = visible.slice(0, vCol);
      const atCursor = vCol < visible.length ? visible[vCol] : ' ';
      const afterCursor = visible.slice(vCol + 1);

      return (
        <Text key={absoluteIdx} wrap="truncate">
          {prefix}
          <Text>{beforeCursor}</Text>
          <Text backgroundColor="white" color="black">{atCursor}</Text>
          <Text>{afterCursor}</Text>
        </Text>
      );
    });
  };

  return (
    <Box ref={rootRef} flexDirection="column" width="100%" borderStyle="single" paddingLeft={1} paddingRight={1}>
      {/* Keyboard shortcut hint bar (hidden when vertical space is tight) */}
      {showHints && (
        <Box marginBottom={1} marginTop={1}>
          <KeyboardHints />
        </Box>
      )}

      {/* Attachment bar (dropped entirely when the height budget is too tight) */}
      {showAttachmentBar && (
        <Box flexDirection="row" marginBottom={attachmentBarMargin}>
          <Text wrap="truncate" dimColor>
            Attachments: {attachmentCount}/{MAX_ATTACHMENTS}
          </Text>
          {deleteMode && (
            <Text color={colors.warning}> [DELETE MODE: 0-{Math.max(0, attachmentCount - 1)} to remove, R to clear all]</Text>
          )}
        </Box>
      )}
      {showAttachmentDetails &&
        attachments.map((att, i) => (
          <Box key={i} flexDirection="row" marginBottom={1}>
            <Text wrap="truncate" dimColor>
              {deleteMode ? `[${i}] ` : ''}📄 {att.name}
            </Text>
          </Box>
        ))}

      {/* Input lines with real cursor, clipped to the row/column budget */}
      <Box flexDirection="column">
        {renderInputLines()}
      </Box>
    </Box>
  );
}

/**
 * Open the external editor ($EDITOR or fallback), read the result.
 * Returns the edited text or null if cancelled/empty.
 */
export async function openExternalEditor(currentText: string): Promise<string | null> {
  const { spawn } = await import('node:child_process');
  const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');

  const dir = await mkdtemp(join(tmpdir(), 'kc-editor-'));
  const filePath = join(dir, 'msg.md');

  await writeFile(filePath, currentText || '', 'utf-8');

  const editor = process.env.EDITOR || process.env.VISUAL || 'nvim';
  const editors = [editor, 'nvim', 'vim', 'vi', 'nano'];

  let exitCode: number | null = null;
  for (const ed of editors) {
    try {
      exitCode = await new Promise<number | null>((resolve) => {
        const proc = spawn(ed, [filePath], { stdio: 'inherit' });
        proc.on('exit', (code) => resolve(code));
        proc.on('error', () => resolve(null));
      });
    } catch {
      // try next
    }
    if (exitCode !== null) break;
  }

  if (exitCode === null || exitCode !== 0) {
    try { await rm(dir, { recursive: true }); } catch { /* ignore */ }
    return null;
  }

  try {
    const content = await readFile(filePath, 'utf-8');
    await rm(dir, { recursive: true });
    return content;
  } catch {
    return null;
  }
}
