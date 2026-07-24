// File Restore Tool (T3 / H3) — undo file writes/edits recorded in the
// session-scoped FileOperationJournal.
//
// Actions:
//   - list       : show the undo history (read-only)
//   - undo-last  : revert the most recent FileWrite/FileEdit/FileRestore
//   - restore    : roll a specific file back to its session-start content
//
// Restores go through the T2 `writeFileAtomic` path (so they are themselves
// backed up) and are appended to the journal, meaning an undo can be undone.

import { z } from 'zod';
import * as path from 'path';
import { buildTool, toolResult, toolError } from '../../Tool';
import type { ToolResult as ToolResultType, ToolUseContext } from '../protocol';
import type { PermissionResult } from '../../permissions/protocol';
import type { FileOperationEntry } from '../../state/file-operation-journal';
import { assertPathWithinWorkspace } from '../../utils/path';
import { getErrorMessage } from '../../utils/errors';

const FileRestoreInputSchema = z.object({
  action: z
    .enum(['undo-last', 'restore', 'list'])
    .describe(
      "Restore action: 'undo-last' reverts the most recent edit, 'restore' rolls a file back to its session-start state, 'list' shows the undo history",
    ),
  file: z
    .string()
    .optional()
    .describe("Target file path, relative to the workspace. Required when action is 'restore'"),
});

type FileRestoreInput = z.infer<typeof FileRestoreInputSchema>;

/** Render a journal entry as a single human-readable history line. */
function formatEntry(entry: FileOperationEntry): string {
  const when = new Date(entry.ts).toISOString();
  const size = entry.newContent === null ? 'deleted' : `${entry.newContent.length}B`;
  return `#${entry.seq} [${entry.operation}] ${entry.filePath} (${size}, turn ${entry.turn}, ${when})`;
}

/**
 * Apply a rollback to `targetContent` for `filePath`, going through the atomic
 * writer (or removing the file when the pre-op state was "did not exist").
 * Returns the content that existed immediately before the rollback plus the
 * backup produced, so the caller can journal a re-undoable entry.
 */
async function applyRollback(
  filePath: string,
  targetContent: string | null,
  context: ToolUseContext,
): Promise<{ before: string | null; backupPath: string | null }> {
  const existedBefore = await context.env.fs.exists(filePath);
  const before = existedBefore ? await context.env.fs.readFile(filePath, 'utf-8') : null;

  if (targetContent === null) {
    // The file did not exist at the baseline → undo means removing it again.
    if (existedBefore) {
      await context.env.fs.rm(filePath);
    }
    return { before, backupPath: null };
  }

  const { backupPath } = await context.env.fs.writeFileAtomic(filePath, targetContent, {
    cwd: context.cwd,
  });
  return { before, backupPath };
}

export const tool = buildTool<FileRestoreInput, string>({
  name: 'FileRestore',
  description: 'Undo file writes/edits from this session or roll a file back to its session-start state',

  inputSchema: FileRestoreInputSchema,

  call: async (input, context): Promise<ToolResultType<string>> => {
    const journal = context.journal;
    if (!journal) {
      return toolError('FileRestore is unavailable: no session file-operation journal in this context.');
    }

    try {
      // ── list ──────────────────────────────────────────────────────────
      if (input.action === 'list') {
        const entries = journal.list();
        if (entries.length === 0) {
          return toolResult('No file operations have been recorded this session.', {
            metadata: { entries: [] },
          });
        }
        const lines = entries.map(formatEntry).join('\n');
        return toolResult(`Undo history (${entries.length} operation(s), most recent last):\n${lines}`, {
          metadata: { entries: entries.map(e => ({ seq: e.seq, filePath: e.filePath, operation: e.operation })) },
        });
      }

      // ── undo-last ─────────────────────────────────────────────────────
      if (input.action === 'undo-last') {
        const entry = journal.last();
        if (!entry) {
          return toolError('Nothing to undo: the session file-operation journal is empty.');
        }
        const { before, backupPath } = await applyRollback(entry.filePath, entry.oldContent, context);
        // Record the undo itself so it can be undone in turn.
        journal.record({
          filePath: entry.filePath,
          operation: 'restore',
          oldContent: before,
          newContent: entry.oldContent,
          backupPath,
        });
        const verb = entry.oldContent === null ? 'Removed (undid create of)' : 'Reverted';
        return toolResult(`${verb} ${entry.filePath} (undid operation #${entry.seq} [${entry.operation}]).`, {
          metadata: { path: entry.filePath, undidSeq: entry.seq, backupPath },
        });
      }

      // ── restore <file> ────────────────────────────────────────────────
      if (!input.file) {
        return toolError("action 'restore' requires a 'file' argument.");
      }
      assertPathWithinWorkspace(input.file, context.cwd);
      const filePath = path.resolve(context.cwd, input.file);
      const baseline = journal.firstForFile(filePath);
      if (!baseline) {
        return toolError(`No recorded operations for ${input.file} this session; cannot restore.`);
      }
      const { before, backupPath } = await applyRollback(filePath, baseline.oldContent, context);
      journal.record({
        filePath,
        operation: 'restore',
        oldContent: before,
        newContent: baseline.oldContent,
        backupPath,
      });
      const verb = baseline.oldContent === null ? 'Removed (restored to pre-session absence)' : 'Restored';
      return toolResult(`${verb} ${input.file} to its session-start state.`, {
        metadata: { path: filePath, restoredFromSeq: baseline.seq, backupPath },
      });
    } catch (error) {
      return toolError(`File restore failed: ${getErrorMessage(error)}`);
    }
  },

  checkPermissions: (input): PermissionResult => {
    if (input.action === 'list') {
      return {
        behavior: 'allow',
        updatedInput: input,
        decisionReason: { type: 'readonly', reason: 'Listing undo history is read-only' },
      };
    }
    const target = input.file ? `: ${input.file}` : '';
    return {
      behavior: 'ask',
      message: `Restore files (${input.action}${target})`,
    };
  },

  isReadOnly: (input) => input.action === 'list',
  isConcurrencySafe: () => false,
  isDestructive: (input) => input.action !== 'list',

  prompt: () =>
    'Undo file changes made this session. Use action=list to review history, action=undo-last to revert the most recent write/edit, or action=restore with a file path to roll that file back to its session-start state.',

  getToolUseSummary: (input) =>
    input.action === 'restore' ? `Restoring: ${input.file ?? '(missing file)'}` : `File restore: ${input.action}`,
  getActivityDescription: (input) =>
    input.action === 'restore'
      ? `Restoring ${input.file ?? 'file'} to session-start state`
      : input.action === 'undo-last'
        ? 'Undoing the most recent file change'
        : 'Listing file undo history',
});
