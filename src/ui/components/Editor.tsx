import React, { useState } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../hooks/useTheme';
import { useTerminalSize } from '../hooks/useTerminalSize';
import { computeOpenCodeLayout } from '../layout';

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
    { key: 'S-Enter', action: 'Newline' },
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

  // Height budget the editor is allotted by the layout. Content must fit
  // within this (minus the border) or it overflows and overlaps the chat
  // panel on small terminals. We progressively reveal chrome as room allows.
  const { editorHeight } = computeOpenCodeLayout(width, height);
  const innerBudget = editorHeight - 2; // subtract top/bottom border rows
  const remaining = innerBudget - 1; // reserve one row for the input line
  const showHints = remaining >= 3; // hint bar needs ~3 rows (with margins)
  const showAttachmentDetails = remaining >= (showHints ? 5 : 2);

  // Build display text with cursor position indicator
  const renderInputLine = () => {
    if (text.length === 0) {
      return (
        <Text>
          {isSteerMode
            ? tokens['input.steer'](promptPrefix)
            : tokens['input.prompt'](promptPrefix)}
          <Text backgroundColor="white" color="black"> </Text>
        </Text>
      );
    }

    // Position the cursor visually by splitting the text at cursorPos
    const beforeCursor = text.slice(0, Math.min(cursorPos, text.length));
    const atCursor = cursorPos < text.length ? text[cursorPos] : ' ';
    const afterCursor = text.slice(Math.min(cursorPos + 1, text.length));

    return (
      <Text>
        {isSteerMode
          ? tokens['input.steer'](promptPrefix)
          : tokens['input.prompt'](promptPrefix)}
        <Text>{beforeCursor}</Text>
        <Text backgroundColor="white" color="black">{atCursor}</Text>
        <Text>{afterCursor}</Text>
      </Text>
    );
  };

  return (
    <Box flexDirection="column" width="100%" borderStyle="single" paddingLeft={1} paddingRight={1}>
      {/* Keyboard shortcut hint bar (hidden when vertical space is tight) */}
      {showHints && (
        <Box marginBottom={1} marginTop={1}>
          <KeyboardHints />
        </Box>
      )}

      {/* Attachment bar */}
      <Box flexDirection="row" marginBottom={1}>
        <Text dimColor>
          Attachments: {attachmentCount}/{MAX_ATTACHMENTS}
        </Text>
        {deleteMode && (
          <Text color={colors.warning}> [DELETE MODE: 0-{Math.max(0, attachmentCount - 1)} to remove, R to clear all]</Text>
        )}
      </Box>
      {showAttachmentDetails &&
        attachments.map((att, i) => (
          <Box key={i} flexDirection="row" marginBottom={1}>
            <Text dimColor>
              {deleteMode ? `[${i}] ` : ''}📄 {att.name}
            </Text>
          </Box>
        ))}

      {/* Input line with real cursor */}
      <Box flexDirection="row">
        {renderInputLine()}
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
