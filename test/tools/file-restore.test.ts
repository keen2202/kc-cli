// Tests for T3 (H3): session undo journal + FileRestore tool.
//
// Drives real writes through FileWriteTool (producing T2 atomic-write metadata),
// mirrors what QueryEngine.executingPhase records into the journal, then
// exercises FileRestore's list / undo-last / restore actions end-to-end against
// a real temp workspace.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createLocalExecutionEnv } from '../../src/services/execution-env-local';
import { FileOperationJournal } from '../../src/state/file-operation-journal';
import { tool as FileWriteTool } from '../../src/tools/FileWriteTool/index';
import { tool as FileRestoreTool } from '../../src/tools/FileRestoreTool/index';

function makeContext(cwd: string, journal?: FileOperationJournal): any {
  return {
    cwd,
    abortController: new AbortController(),
    permissions: { mode: 'auto', rules: [], bypassEnabled: false },
    env: createLocalExecutionEnv(cwd),
    journal,
  };
}

/** Write via FileWriteTool and mirror QueryEngine's journal recording. */
async function writeAndJournal(
  cwd: string,
  journal: FileOperationJournal,
  relPath: string,
  content: string,
): Promise<void> {
  const res: any = await FileWriteTool.call(
    { path: relPath, content, append: false },
    makeContext(cwd, journal),
  );
  expect(res.isError).toBeFalsy();
  const m = res.metadata;
  journal.record({
    filePath: m.path,
    operation: 'write',
    oldContent: (m.oldContent ?? null) as string | null,
    newContent: (m.newContent ?? null) as string | null,
    backupPath: (m.backupPath ?? null) as string | null,
  });
}

describe('FileRestore tool (T3)', () => {
  let tmpDir: string;
  let journal: FileOperationJournal;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'file-restore-test-'));
    journal = new FileOperationJournal();
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it('undo-last reverts the most recent write to its previous content', async () => {
    await fs.promises.writeFile(path.join(tmpDir, 'a.txt'), 'original', 'utf-8');
    await writeAndJournal(tmpDir, journal, 'a.txt', 'modified');
    expect(await fs.promises.readFile(path.join(tmpDir, 'a.txt'), 'utf-8')).toBe('modified');

    const res: any = await FileRestoreTool.call({ action: 'undo-last' }, makeContext(tmpDir, journal));

    expect(res.isError).toBeFalsy();
    const restored = await fs.promises.readFile(path.join(tmpDir, 'a.txt'), 'utf-8');
    expect(restored).toBe('original');
    expect(restored.length).toBe('original'.length);
  });

  it('restore rolls a file back to its session-start content across multiple edits', async () => {
    await fs.promises.writeFile(path.join(tmpDir, 'b.txt'), 'base', 'utf-8');
    await writeAndJournal(tmpDir, journal, 'b.txt', 'edit1');
    await writeAndJournal(tmpDir, journal, 'b.txt', 'edit2');
    expect(await fs.promises.readFile(path.join(tmpDir, 'b.txt'), 'utf-8')).toBe('edit2');

    const res: any = await FileRestoreTool.call(
      { action: 'restore', file: 'b.txt' },
      makeContext(tmpDir, journal),
    );

    expect(res.isError).toBeFalsy();
    expect(await fs.promises.readFile(path.join(tmpDir, 'b.txt'), 'utf-8')).toBe('base');
  });

  it('an undo can itself be undone (re-undo)', async () => {
    await fs.promises.writeFile(path.join(tmpDir, 'c.txt'), 's1', 'utf-8');
    await writeAndJournal(tmpDir, journal, 'c.txt', 's2');

    // First undo: s2 -> s1
    await FileRestoreTool.call({ action: 'undo-last' }, makeContext(tmpDir, journal));
    expect(await fs.promises.readFile(path.join(tmpDir, 'c.txt'), 'utf-8')).toBe('s1');

    // Second undo: undoes the undo, restoring s2
    await FileRestoreTool.call({ action: 'undo-last' }, makeContext(tmpDir, journal));
    expect(await fs.promises.readFile(path.join(tmpDir, 'c.txt'), 'utf-8')).toBe('s2');
  });

  it('undoing a newly-created file removes it', async () => {
    // File does not exist beforehand → FileWrite records oldContent=null.
    await writeAndJournal(tmpDir, journal, 'd.txt', 'brand new');
    expect(fs.existsSync(path.join(tmpDir, 'd.txt'))).toBe(true);

    const res: any = await FileRestoreTool.call({ action: 'undo-last' }, makeContext(tmpDir, journal));

    expect(res.isError).toBeFalsy();
    expect(fs.existsSync(path.join(tmpDir, 'd.txt'))).toBe(false);
  });

  it('list reports history and reports empty history distinctly', async () => {
    const empty: any = await FileRestoreTool.call({ action: 'list' }, makeContext(tmpDir, journal));
    expect(empty.isError).toBeFalsy();
    expect(empty.output).toContain('No file operations');

    await writeAndJournal(tmpDir, journal, 'e.txt', 'hello');
    const listed: any = await FileRestoreTool.call({ action: 'list' }, makeContext(tmpDir, journal));
    expect(listed.output).toContain('e.txt');
    expect(listed.metadata.entries).toHaveLength(1);
  });

  it('fails cleanly when no journal is present in the context', async () => {
    const res: any = await FileRestoreTool.call({ action: 'undo-last' }, makeContext(tmpDir, undefined));
    expect(res.isError).toBe(true);
    expect(res.message).toContain('no session file-operation journal');
  });

  it('isolates journals so one session cannot undo another (sub-agent isolation)', async () => {
    const journalA = new FileOperationJournal();
    const journalB = new FileOperationJournal();

    await fs.promises.writeFile(path.join(tmpDir, 'shared.txt'), 'A-base', 'utf-8');
    await writeAndJournal(tmpDir, journalA, 'shared.txt', 'A-edit');

    // journalB has no record of the write → cannot undo it.
    const res: any = await FileRestoreTool.call({ action: 'undo-last' }, makeContext(tmpDir, journalB));
    expect(res.isError).toBe(true);
    expect(res.message).toContain('journal is empty');
    // File is untouched by the failed cross-journal undo.
    expect(await fs.promises.readFile(path.join(tmpDir, 'shared.txt'), 'utf-8')).toBe('A-edit');
  });

  it('classifies permissions: list is read-only, mutations ask', () => {
    const listPerm = FileRestoreTool.checkPermissions!({ action: 'list' } as any, makeContext(tmpDir, journal));
    expect(listPerm.behavior).toBe('allow');

    const undoPerm = FileRestoreTool.checkPermissions!({ action: 'undo-last' } as any, makeContext(tmpDir, journal));
    expect(undoPerm.behavior).toBe('ask');

    expect(FileRestoreTool.isReadOnly!({ action: 'list' } as any)).toBe(true);
    expect(FileRestoreTool.isReadOnly!({ action: 'undo-last' } as any)).toBe(false);
    expect(FileRestoreTool.isDestructive!({ action: 'restore', file: 'x' } as any)).toBe(true);
  });
});
