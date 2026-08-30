// LocalExecutionEnv - Node.js-backed implementation of ExecutionEnv

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  ExecutionEnv,
  FileSystem,
  FileStat,
  Shell,
  ShellResult,
  ShellOptions,
  AtomicWriteOptions,
  AtomicWriteResult,
} from './execution-env';
import { DEFAULT_MAX_BUFFER } from '../constants';
import { logger } from './logger';
import { getErrorMessage, isAbortError } from '../utils/errors';
import { buildSafeEnv } from '../utils/env-sanitize';
import { withFileLock } from './file-lock';

const execAsync = promisify(exec);

/** Default number of rolling backups retained per file under `.kc-cli/backups/`. */
const DEFAULT_MAX_BACKUPS = 5;

export class LocalFileSystem implements FileSystem {
  async readFile(filePath: string, encoding: BufferEncoding = 'utf-8'): Promise<string> {
    return fs.promises.readFile(filePath, { encoding });
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    await fs.promises.writeFile(filePath, content, 'utf-8');
  }

  /**
   * T2 (H2): atomic write with a best-effort timestamped backup.
   * 1. If the target exists, copy it to `.kc-cli/backups/<relpath>.<ts>.bak`
   *    (best-effort; failure is recorded but does not abort the write).
   * 2. Write to a sibling temp file, then `rename` over the target so a crash
   *    mid-write leaves the temp file rather than a truncated target.
   */
  async writeFileAtomic(
    filePath: string,
    content: string,
    options: AtomicWriteOptions = {},
  ): Promise<AtomicWriteResult> {
    const cwd = options.cwd ?? process.cwd();
    const backup = options.backup ?? true;
    const maxBackups = options.maxBackups ?? DEFAULT_MAX_BACKUPS;

    let backupPath: string | null = null;
    let backupFailed = false;

    // 1. Snapshot existing target (best-effort).
    if (backup && (await this.exists(filePath))) {
      try {
        backupPath = await this.createBackup(filePath, cwd, maxBackups);
      } catch (err) {
        backupFailed = true;
        logger.services.warn(
          `[atomic-write] backup failed for ${filePath}: ${getErrorMessage(err)}`,
        );
      }
    }

    // 2. Atomic replace via temp file + rename in the same directory.
    const dir = path.dirname(filePath);
    await fs.promises.mkdir(dir, { recursive: true });
    const tmpPath = path.join(
      dir,
      `.${path.basename(filePath)}.tmp-${randomBytes(6).toString('hex')}`,
    );
    try {
      await fs.promises.writeFile(tmpPath, content, 'utf-8');
      await fs.promises.rename(tmpPath, filePath);
    } catch (err) {
      // Clean up the temp file so failures never leave stray artifacts.
      try {
        await fs.promises.rm(tmpPath, { force: true });
      } catch {
        /* ignore cleanup failure */
      }
      throw err;
    }

    return { backupPath, backupFailed };
  }

  /** Copy `filePath` into `.kc-cli/backups/` and prune to `maxBackups`. */
  private async createBackup(filePath: string, cwd: string, maxBackups: number): Promise<string> {
    const rel = path.relative(cwd, filePath).replace(/\\/g, '/');
    // Guard paths outside cwd (rel starts with '..' or is absolute): use the
    // basename so backups always land inside the workspace backup root.
    const safeRel = rel.startsWith('..') || path.isAbsolute(rel) ? path.basename(filePath) : rel;
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = path.join(cwd, '.kc-cli', 'backups', path.dirname(safeRel));
    await fs.promises.mkdir(backupDir, { recursive: true });
    const baseName = path.basename(safeRel);
    // Timestamp prefix keeps chronological sort order; the random suffix avoids
    // collisions when two writes land in the same millisecond.
    const backupPath = path.join(backupDir, `${baseName}.${ts}-${randomBytes(3).toString('hex')}.bak`);
    await fs.promises.copyFile(filePath, backupPath);
    await this.pruneBackups(backupDir, baseName, maxBackups);
    return backupPath;
  }

  /** Keep only the newest `maxBackups` snapshots for a given file (best-effort). */
  private async pruneBackups(backupDir: string, baseName: string, maxBackups: number): Promise<void> {
    try {
      const entries = await fs.promises.readdir(backupDir);
      const prefix = `${baseName}.`;
      // ISO timestamps sort lexicographically == chronologically.
      const backups = entries.filter(e => e.startsWith(prefix) && e.endsWith('.bak')).sort();
      const excess = backups.length - maxBackups;
      for (let i = 0; i < excess; i++) {
        await fs.promises.rm(path.join(backupDir, backups[i]!), { force: true });
      }
    } catch {
      /* best-effort pruning; ignore errors */
    }
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
        // `options.env` is already sanitized by the caller (buildSafeEnv).
        // Spreading `process.env` beneath it would re-introduce every KC_* the
        // filter just stripped. When the caller supplies nothing we fall back to
        // a sanitized baseline rather than inheriting the full host environment.
        env: options.env ?? buildSafeEnv(),
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
      // R7: a cancellation is not a command failure. Node's AbortError arrives
      // as a rejected exec (code ABORT_ERR), and without this guard it was
      // rewritten into `exitCode: 1` — so hitting Ctrl+C looked to the model
      // exactly like the command crashed. Re-throw so the tool layer can
      // report "cancelled".
      if (isAbortError(error)) {
        logger.services.info('[shell] command aborted by signal', {
          command: command.slice(0, 200),
        });
        throw error;
      }

      // exec throws on non-zero exit codes
      const err = error as { stdout?: string; stderr?: string; code?: number; killed?: boolean; signal?: string };
      const exitCode = typeof err.code === 'number' ? err.code : 1;
      const stderr = typeof err.stderr === 'string' ? err.stderr : String(error);
      // Always leave a structured trace for failed commands so shell failures
      // are diagnosable from logs (command, exit code, stderr, timeout kill).
      logger.services.warn(
        `[shell] Command failed (exit ${exitCode}${err.killed ? `, killed${err.signal ? ` by ${err.signal}` : ''}` : ''}): ` +
          `${command.slice(0, 200)}${stderr.trim() ? ` — stderr: ${stderr.trim().slice(0, 300)}` : ''}`
      );
      return {
        stdout: typeof err.stdout === 'string' ? err.stdout : '',
        stderr,
        exitCode,
      };
    }
  }
}

export function createLocalExecutionEnv(cwd: string): ExecutionEnv {
  return {
    fs: new LocalFileSystem(),
    shell: new LocalShell(),
    cwd,
    withFileLock,
  };
}
