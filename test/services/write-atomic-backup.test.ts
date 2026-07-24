// Tests for T2 (H2): atomic file writes with timestamped backups.
//
// Covers:
// - writeFileAtomic on a new target (no backup, content written)
// - writeFileAtomic over an existing target (timestamped .bak with old content)
// - no stray `.tmp-*` residue is left after a successful write
// - errors propagate without corrupting an existing target
// - rolling cleanup keeps only `maxBackups` snapshots per file
// - FileWriteTool surfaces `backupPath` in result metadata

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { LocalFileSystem, createLocalExecutionEnv } from '../../src/services/execution-env-local';
import { tool as FileWriteTool } from '../../src/tools/FileWriteTool/index';

const BACKUP_ROOT = path.join('.kc-cli', 'backups');

/** List backup snapshots for `baseName` under the workspace backup root. */
function listBackups(cwd: string, baseName: string): string[] {
  const dir = path.join(cwd, BACKUP_ROOT);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(e => e.startsWith(`${baseName}.`) && e.endsWith('.bak'));
}

describe('LocalFileSystem.writeFileAtomic', () => {
  let tmpDir: string;
  let lfs: LocalFileSystem;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'atomic-write-test-'));
    lfs = new LocalFileSystem();
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it('writes a new file without creating a backup', async () => {
    const filePath = path.join(tmpDir, 'new.txt');
    const result = await lfs.writeFileAtomic(filePath, 'hello', { cwd: tmpDir });

    expect(await fs.promises.readFile(filePath, 'utf-8')).toBe('hello');
    expect(result.backupPath).toBeNull();
    expect(result.backupFailed).toBe(false);
    expect(listBackups(tmpDir, 'new.txt')).toHaveLength(0);
  });

  it('backs up the previous content when overwriting an existing file', async () => {
    const filePath = path.join(tmpDir, 'notes.txt');
    await fs.promises.writeFile(filePath, 'original', 'utf-8');

    const result = await lfs.writeFileAtomic(filePath, 'updated', { cwd: tmpDir });

    // Target holds the new content.
    expect(await fs.promises.readFile(filePath, 'utf-8')).toBe('updated');
    // A backup was produced under .kc-cli/backups/ holding the OLD content.
    expect(result.backupPath).toBeTruthy();
    expect(result.backupFailed).toBe(false);
    expect(fs.existsSync(result.backupPath!)).toBe(true);
    expect(await fs.promises.readFile(result.backupPath!, 'utf-8')).toBe('original');
    expect(listBackups(tmpDir, 'notes.txt')).toHaveLength(1);
  });

  it('leaves no temp-file residue after a successful write', async () => {
    const filePath = path.join(tmpDir, 'clean.txt');
    await lfs.writeFileAtomic(filePath, 'v1', { cwd: tmpDir });
    await lfs.writeFileAtomic(filePath, 'v2', { cwd: tmpDir });

    const stray = fs.readdirSync(tmpDir).filter(e => e.includes('.tmp-'));
    expect(stray).toHaveLength(0);
    expect(await fs.promises.readFile(filePath, 'utf-8')).toBe('v2');
  });

  it('propagates errors without corrupting an existing target', async () => {
    // A file where a directory is expected forces mkdir/rename to fail, so the
    // atomic write must reject rather than truncate anything.
    const blocker = path.join(tmpDir, 'blocker');
    await fs.promises.writeFile(blocker, 'keep me', 'utf-8');

    await expect(
      lfs.writeFileAtomic(path.join(blocker, 'child.txt'), 'data', { cwd: tmpDir }),
    ).rejects.toThrow();

    // The pre-existing file is untouched and no temp residue is left behind.
    expect(await fs.promises.readFile(blocker, 'utf-8')).toBe('keep me');
    expect(fs.readdirSync(tmpDir).filter(e => e.includes('.tmp-'))).toHaveLength(0);
  });

  it('rolls over backups, keeping only maxBackups snapshots', async () => {
    const filePath = path.join(tmpDir, 'rolling.txt');
    await fs.promises.writeFile(filePath, 'seed', 'utf-8');

    // 6 overwrites of an existing file → 6 backups, pruned to maxBackups=3.
    for (let i = 0; i < 6; i++) {
      await lfs.writeFileAtomic(filePath, `v${i}`, { cwd: tmpDir, maxBackups: 3 });
      // Small gap so ISO-millisecond timestamps stay distinct and sortable.
      await new Promise(resolve => setTimeout(resolve, 3));
    }

    expect(listBackups(tmpDir, 'rolling.txt')).toHaveLength(3);
    expect(await fs.promises.readFile(filePath, 'utf-8')).toBe('v5');
  });

  it('defaults to retaining five rolling backups', async () => {
    const filePath = path.join(tmpDir, 'defaults.txt');
    await fs.promises.writeFile(filePath, 'seed', 'utf-8');

    for (let i = 0; i < 8; i++) {
      await lfs.writeFileAtomic(filePath, `v${i}`, { cwd: tmpDir });
      await new Promise(resolve => setTimeout(resolve, 3));
    }

    expect(listBackups(tmpDir, 'defaults.txt')).toHaveLength(5);
  });
});

describe('FileWriteTool atomic-write metadata', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'atomic-tool-test-'));
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it('surfaces backupPath/backupFailed in metadata when overwriting', async () => {
    await fs.promises.writeFile(path.join(tmpDir, 'doc.txt'), 'before', 'utf-8');

    const result: any = await FileWriteTool.call(
      { path: 'doc.txt', content: 'after', append: false },
      {
        cwd: tmpDir,
        permissions: { mode: 'auto', rules: [], bypassEnabled: false },
        env: createLocalExecutionEnv(tmpDir),
      } as any,
    );

    expect(result.isError).toBeFalsy();
    expect(result.metadata.backupFailed).toBe(false);
    expect(typeof result.metadata.backupPath).toBe('string');
    expect(fs.existsSync(result.metadata.backupPath)).toBe(true);
    expect(await fs.promises.readFile(result.metadata.backupPath, 'utf-8')).toBe('before');
    expect(await fs.promises.readFile(path.join(tmpDir, 'doc.txt'), 'utf-8')).toBe('after');
  });

  it('reports a null backupPath when creating a brand-new file', async () => {
    const result: any = await FileWriteTool.call(
      { path: 'fresh.txt', content: 'new content', append: false },
      {
        cwd: tmpDir,
        permissions: { mode: 'auto', rules: [], bypassEnabled: false },
        env: createLocalExecutionEnv(tmpDir),
      } as any,
    );

    expect(result.isError).toBeFalsy();
    expect(result.metadata.backupPath).toBeNull();
    expect(result.metadata.backupFailed).toBe(false);
    expect(await fs.promises.readFile(path.join(tmpDir, 'fresh.txt'), 'utf-8')).toBe('new content');
  });
});
