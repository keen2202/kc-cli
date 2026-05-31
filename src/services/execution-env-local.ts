// LocalExecutionEnv - Node.js-backed implementation of ExecutionEnv

import * as fs from 'node:fs';
import * as path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { ExecutionEnv, FileSystem, FileStat, Shell, ShellResult, ShellOptions } from './execution-env';
import { DEFAULT_MAX_BUFFER } from '../constants';

const execAsync = promisify(exec);

export class LocalFileSystem implements FileSystem {
  async readFile(filePath: string, encoding: BufferEncoding = 'utf-8'): Promise<string> {
    return fs.promises.readFile(filePath, { encoding });
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    await fs.promises.writeFile(filePath, content, 'utf-8');
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      await fs.promises.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async stat(filePath: string): Promise<FileStat> {
    const s = await fs.promises.stat(filePath);
    return {
      size: s.size,
      mtime: s.mtime,
      isFile: s.isFile(),
      isDirectory: s.isDirectory(),
    };
  }

  async glob(pattern: string, cwd: string): Promise<string[]> {
    // Convert glob pattern to regex for matching
    const GLOB_ESCAPE_REGEX = /[.+^${}()|[\]\\]/g;
    const regexStr = pattern
      .replace(GLOB_ESCAPE_REGEX, '\\$&')
      .replace(/\*\*/g, '___DOUBLE___')
      .replace(/\*/g, '___SINGLE___')
      .replace(/___DOUBLE___/g, '.*')
      .replace(/___SINGLE___/g, '[^/]*')
      .replace(/\?/g, '[^/]');
    const regex = new RegExp(`^${regexStr}$`);
    const results: string[] = [];

    async function walk(dir: string): Promise<void> {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relativePath = path.relative(cwd, fullPath);
        if (entry.isDirectory()) {
          if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
            await walk(fullPath);
          }
        } else if (entry.isFile()) {
          if (regex.test(relativePath)) {
            results.push(relativePath);
          }
        }
      }
    }

    await walk(cwd);
    return results;
  }

  async mkdir(dirPath: string, options?: { recursive?: boolean }): Promise<void> {
    await fs.promises.mkdir(dirPath, { recursive: options?.recursive ?? true });
  }

  async rm(filePath: string, options?: { recursive?: boolean }): Promise<void> {
    await fs.promises.rm(filePath, { recursive: options?.recursive ?? false, force: true });
  }
}

export class LocalShell implements Shell {
  async exec(command: string, options: ShellOptions): Promise<ShellResult> {
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: options.cwd,
        env: options.env ? { ...process.env, ...options.env } : undefined,
        timeout: options.timeout,
        maxBuffer: DEFAULT_MAX_BUFFER,
        signal: options.signal,
      });
      return {
        stdout: typeof stdout === 'string' ? stdout : String(stdout),
        stderr: typeof stderr === 'string' ? stderr : String(stderr),
        exitCode: 0,
      };
    } catch (error: unknown) {
      // exec throws on non-zero exit codes
      const err = error as { stdout?: string; stderr?: string; code?: number };
      return {
        stdout: typeof err.stdout === 'string' ? err.stdout : '',
        stderr: typeof err.stderr === 'string' ? err.stderr : String(error),
        exitCode: typeof err.code === 'number' ? err.code : 1,
      };
    }
  }
}

export function createLocalExecutionEnv(cwd: string): ExecutionEnv {
  return {
    fs: new LocalFileSystem(),
    shell: new LocalShell(),
    cwd,
  };
}
