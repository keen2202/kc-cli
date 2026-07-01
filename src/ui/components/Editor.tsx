import React, { useState } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../hooks/useTheme';

interface Attachment {
  path: string;
  name: string;
}

interface EditorProps {
  text: string;
  cursorPos: number;
  isSteerMode?: boolean;
  placeholder?: string;
  attachments?: Attachment[];
  deleteMode?: boolean;
}

const MAX_ATTACHMENTS = 5;

export function Editor({
  text,
  cursorPos: _cursorPos,
  isSteerMode = false,
  placeholder,
  attachments = [],
  deleteMode = false,
}: EditorProps) {
  const { tokens } = useTheme();
  const promptPrefix = isSteerMode ? 'steer> ' : 'kc> ';
  const displayText = text || placeholder || 'Ask anything, @file to attach...';

  const attachmentCount = attachments.length;

  return (
    <Box flexDirection="column" borderStyle="single" paddingLeft={1} paddingRight={1}>
      {/* Attachment bar */}
      <Box flexDirection="row" marginBottom={1}>
        <Text dimColor>
          Attachments: {attachmentCount}/{MAX_ATTACHMENTS}
        </Text>
        {deleteMode && (
          <Text color="yellow"> [DELETE MODE: 0-{Math.max(0, attachmentCount - 1)} to remove, R to clear all]</Text>
        )}
      </Box>
      {attachments.map((att, i) => (
        <Box key={i} flexDirection="row" marginBottom={1}>
          <Text dimColor>
            {deleteMode ? `[${i}] ` : ''}📄 {att.name}
          </Text>
        </Box>
      ))}

      {/* Input line */}
      <Box flexDirection="row">
        <Text>
          {isSteerMode
            ? tokens['input.steer'](promptPrefix)
            : tokens['input.prompt'](promptPrefix)}
        </Text>
        <Text dimColor={text.length === 0}>{displayText}</Text>
        {/* Cursor indicator */}
        {text.length > 0 && <Text>{'█'.slice(0, 0)}</Text>}
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
