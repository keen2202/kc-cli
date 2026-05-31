// Tests for ExecutionEnv abstraction

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { LocalFileSystem, LocalShell, createLocalExecutionEnv } from '../../src/services/execution-env-local';
import { MockFileSystem, MockShell, createMockExecutionEnv } from '../../src/services/execution-env-mock';
import type { ExecutionEnv } from '../../src/services/execution-env';

describe('LocalFileSystem', () => {
  let tmpDir: string;
  let lfs: LocalFileSystem;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'exec-env-test-'));
    lfs = new LocalFileSystem();
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it('readFile reads file content', async () => {
    const filePath = path.join(tmpDir, 'test.txt');
    await fs.promises.writeFile(filePath, 'hello world');
    const content = await lfs.readFile(filePath);
    expect(content).toBe('hello world');
  });

  it('writeFile creates file', async () => {
    const filePath = path.join(tmpDir, 'output.txt');
    await lfs.writeFile(filePath, 'some content');
    const content = await fs.promises.readFile(filePath, 'utf-8');
    expect(content).toBe('some content');
  });

  it('exists returns true for existing file', async () => {
    const filePath = path.join(tmpDir, 'existing.txt');
    await fs.promises.writeFile(filePath, 'data');
    expect(await lfs.exists(filePath)).toBe(true);
  });

  it('exists returns false for missing file', async () => {
    expect(await lfs.exists(path.join(tmpDir, 'nope.txt'))).toBe(false);
  });

  it('stat returns correct file info', async () => {
    const filePath = path.join(tmpDir, 'stat.txt');
    await fs.promises.writeFile(filePath, 'abc');
    const s = await lfs.stat(filePath);
    expect(s.size).toBe(3);
    expect(s.isFile).toBe(true);
    expect(s.isDirectory).toBe(false);
    expect(s.mtime).toBeInstanceOf(Date);
  });

  it('stat returns directory info', async () => {
    const s = await lfs.stat(tmpDir);
    expect(s.isFile).toBe(false);
    expect(s.isDirectory).toBe(true);
  });

  it('mkdir creates directories recursively', async () => {
    const dirPath = path.join(tmpDir, 'a', 'b', 'c');
    await lfs.mkdir(dirPath, { recursive: true });
    const stat = await fs.promises.stat(dirPath);
    expect(stat.isDirectory()).toBe(true);
  });

  it('rm removes a file', async () => {
    const filePath = path.join(tmpDir, 'to-delete.txt');
    await fs.promises.writeFile(filePath, 'delete me');
    await lfs.rm(filePath);
    await expect(fs.promises.access(filePath)).rejects.toThrow();
  });

  it('glob finds matching files', async () => {
    await fs.promises.writeFile(path.join(tmpDir, 'a.ts'), '');
    await fs.promises.writeFile(path.join(tmpDir, 'b.ts'), '');
    await fs.promises.writeFile(path.join(tmpDir, 'c.js'), '');
    const results = await lfs.glob('*.ts', tmpDir);
    expect(results.sort()).toEqual(['a.ts', 'b.ts']);
  });
});

describe('LocalShell', () => {
  let shell: LocalShell;

  beforeEach(() => {
    shell = new LocalShell();
  });

  it('exec returns stdout on success', async () => {
    const result = await shell.exec('echo hello', {});
    expect(result.stdout.trim()).toBe('hello');
    expect(result.exitCode).toBe(0);
  });

  it('exec returns non-zero exit code on failure', async () => {
    const result = await shell.exec('exit 42', {});
    expect(result.exitCode).toBe(42);
  });

  it('exec captures stderr', async () => {
    const result = await shell.exec('echo err >&2', {});
    expect(result.stderr.trim()).toBe('err');
    expect(result.exitCode).toBe(0);
  });

  it('exec respects cwd option', async () => {
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'shell-test-'));
    try {
      const result = await shell.exec('pwd', { cwd: tmpDir });
      expect(result.stdout.trim()).toBe(tmpDir);
    } finally {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('createLocalExecutionEnv', () => {
  it('creates an ExecutionEnv with all required fields', () => {
    const env = createLocalExecutionEnv('/test');
    expect(env.fs).toBeDefined();
    expect(env.shell).toBeDefined();
    expect(env.cwd).toBe('/test');
  });
});

describe('MockFileSystem', () => {
  let mfs: MockFileSystem;

  beforeEach(() => {
    mfs = new MockFileSystem();
  });

  it('seed populates files', async () => {
    mfs.seed({ '/a.txt': 'content a', '/b.txt': 'content b' });
    expect(await mfs.readFile('/a.txt')).toBe('content a');
    expect(await mfs.readFile('/b.txt')).toBe('content b');
    expect(mfs.listFiles()).toEqual(['/a.txt', '/b.txt']);
  });

  it('readFile throws for missing file', async () => {
    await expect(mfs.readFile('/nope')).rejects.toThrow('ENOENT');
  });

  it('writeFile creates a new file', async () => {
    await mfs.writeFile('/new.txt', 'hello');
    expect(await mfs.readFile('/new.txt')).toBe('hello');
  });

  it('writeFile overwrites existing file', async () => {
    mfs.seed({ '/f.txt': 'old' });
    await mfs.writeFile('/f.txt', 'new');
    expect(await mfs.readFile('/f.txt')).toBe('new');
  });

  it('exists returns true/false correctly', async () => {
    mfs.seed({ '/exists.txt': '' });
    expect(await mfs.exists('/exists.txt')).toBe(true);
    expect(await mfs.exists('/nope.txt')).toBe(false);
  });

  it('stat returns correct info', async () => {
    mfs.seed({ '/s.txt': 'abc' });
    const s = await mfs.stat('/s.txt');
    expect(s.size).toBe(3);
    expect(s.isFile).toBe(true);
    expect(s.isDirectory).toBe(false);
    expect(s.mtime).toBeInstanceOf(Date);
  });

  it('stat throws for missing file', async () => {
    await expect(mfs.stat('/nope')).rejects.toThrow('ENOENT');
  });

  it('glob finds matching files', async () => {
    mfs.seed({ 'a.ts': '', 'b.ts': '', 'c.js': '' });
    const results = await mfs.glob('*.ts', '/mock');
    expect(results.sort()).toEqual(['a.ts', 'b.ts']);
  });

  it('rm deletes a file', async () => {
    mfs.seed({ '/del.txt': 'bye' });
    await mfs.rm('/del.txt');
    expect(await mfs.exists('/del.txt')).toBe(false);
  });

  it('rm throws for missing file', async () => {
    await expect(mfs.rm('/nope')).rejects.toThrow('ENOENT');
  });
});

describe('MockShell', () => {
  let shell: MockShell;

  beforeEach(() => {
    shell = new MockShell();
  });

  it('returns default result for unmatched commands', async () => {
    const result = await shell.exec('anything', {});
    expect(result.stdout).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('returns custom default result', async () => {
    shell.setDefault({ stdout: 'default', stderr: 'err', exitCode: 1 });
    const result = await shell.exec('anything', {});
    expect(result.stdout).toBe('default');
    expect(result.exitCode).toBe(1);
  });

  it('matches command by pattern', async () => {
    shell.on(/^echo (.+)$/, (cmd) => ({
      stdout: cmd.replace('echo ', ''),
      stderr: '',
      exitCode: 0,
    }));
    const result = await shell.exec('echo hello', {});
    expect(result.stdout).toBe('hello');
  });

  it('first matching pattern wins', async () => {
    shell.on(/first/, () => ({ stdout: 'first', stderr: '', exitCode: 0 }));
    shell.on(/first/, () => ({ stdout: 'second', stderr: '', exitCode: 0 }));
    const result = await shell.exec('first', {});
    expect(result.stdout).toBe('first');
  });

  it('records executed commands', async () => {
    await shell.exec('cmd1', { cwd: '/a' });
    await shell.exec('cmd2', { cwd: '/b' });
    expect(shell.executedCommands).toHaveLength(2);
    expect(shell.executedCommands[0].command).toBe('cmd1');
    expect(shell.executedCommands[0].options.cwd).toBe('/a');
    expect(shell.executedCommands[1].command).toBe('cmd2');
  });
});

describe('createMockExecutionEnv', () => {
  it('creates a mock ExecutionEnv', () => {
    const env = createMockExecutionEnv('/test');
    expect(env.fs).toBeInstanceOf(MockFileSystem);
    expect(env.shell).toBeInstanceOf(MockShell);
    expect(env.cwd).toBe('/test');
  });

  it('defaults cwd to /mock', () => {
    const env = createMockExecutionEnv();
    expect(env.cwd).toBe('/mock');
  });
});

describe('Tool execution with MockExecutionEnv', () => {
  it('mock env works as a drop-in for tool operations', async () => {
    const env = createMockExecutionEnv('/workspace');

    // Seed some files
    (env.fs as MockFileSystem).seed({
      '/workspace/src/index.ts': 'console.log("hello");',
    });

    // Read a file
    const content = await env.fs.readFile('/workspace/src/index.ts');
    expect(content).toBe('console.log("hello");');

    // Write a file
    await env.fs.writeFile('/workspace/src/utils.ts', 'export const x = 1;');
    expect(await env.fs.readFile('/workspace/src/utils.ts')).toBe('export const x = 1;');

    // Execute a command
    (env.shell as MockShell).on(/^ls/, () => ({
      stdout: 'index.ts\nutils.ts\n',
      stderr: '',
      exitCode: 0,
    }));
    const result = await env.shell.exec('ls /workspace/src', { cwd: env.cwd });
    expect(result.stdout).toContain('index.ts');
    expect(result.exitCode).toBe(0);
  });
});
