// Shared Git utility - extracted from GitTool for reuse across modules

import { spawn } from 'child_process';
import { DEFAULT_MAX_BUFFER } from '../constants';
import { createLogger } from '../services/logger';

// Shell metacharacters and control chars that could enable command injection
const SHELL_METACHAR_REGEX = /[;&|`$(){}!#~<>\n\r]/;

const gitLogger = createLogger('git');

// T4 (H4): debounce flags so a broken/absent Git safety net is surfaced exactly
// once per process instead of being silently swallowed (or spamming the log).
let autoStageWarned = false;
let autoCommitWarned = false;

/**
 * Parse a git command string into safe argument array.
 * Rejects shell metacharacters to prevent command injection.
 */
export function parseGitArgs(command: string): string[] {
  const trimmed = command.trim();
  if (!trimmed) throw new Error('Empty git command');

  if (SHELL_METACHAR_REGEX.test(trimmed)) {
    throw new Error(
      `Git command contains forbidden shell metacharacters: ${trimmed.slice(0, 100)}`
    );
  }

  const args: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];

    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      } else {
        current += ch;
      }
    } else if (inDouble) {
      if (ch === '"') {
        inDouble = false;
      } else if (ch === '\\' && i + 1 < trimmed.length) {
        const next = trimmed[i + 1];
        if (next === '"' || next === '\\') {
          current += next;
          i++;
        } else {
          current += ch;
        }
      } else {
        current += ch;
      }
    } else if (ch === "'") {
      inSingle = true;
    } else if (ch === '"') {
      inDouble = true;
    } else if (ch === ' ' || ch === '\t') {
      if (current.length > 0) {
        args.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }

  if (current.length > 0) args.push(current);
  return args;
}

/**
 * Spawn a git process with the given command string.
 * Returns stdout and stderr on success, rejects on failure.
 */
export function spawnGit(
  command: string,
  cwd: string,
  timeout: number
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const args = parseGitArgs(command);
    const child = spawn('git', ['-c', 'color.ui=never', ...args], {
      cwd,
      timeout,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.length > DEFAULT_MAX_BUFFER) {
        child.kill();
        reject(new Error('Git output exceeded max buffer size'));
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > DEFAULT_MAX_BUFFER) {
        child.kill();
        reject(new Error('Git stderr output exceeded max buffer size'));
      }
    });

    child.on('error', (err) => {
      reject(err);
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const err = new Error(`git exited with code ${code}`) as Error & {
          code: number | null;
          stdout: string;
          stderr: string;
        };
        err.code = code;
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      }
    });
  });
}

/**
 * T4 (H4): Detect whether `cwd` is inside a Git work tree.
 * Returns false when git is unavailable or the directory is not a repository,
 * so callers can surface a rollback-safety-net warning at bootstrap.
 */
export async function isInsideGitRepo(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await spawnGit('rev-parse --is-inside-work-tree', cwd, 5000);
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * Reset the auto-stage/commit warn debounce flags. Intended for tests that need
 * to assert the "warn exactly once" behavior in isolation.
 */
export function resetGitWarnDebounce(): void {
  autoStageWarned = false;
  autoCommitWarned = false;
}

/**
 * Auto-stage a file via git add (fire-and-forget, best-effort).
 * T4 (H4): the FIRST failure (spawn error or non-zero exit) is surfaced via a
 * debounced logger.warn so a broken Git safety net is observable rather than
 * silently swallowed. Subsequent failures stay quiet to avoid log spam.
 */
export function autoStageFile(filePath: string, cwd: string): void {
  const child = spawn('git', ['add', filePath], {
    cwd,
    stdio: 'ignore',
    windowsHide: true,
    timeout: 10000,
  });
  const warnOnce = (reason: string): void => {
    if (autoStageWarned) return;
    autoStageWarned = true;
    gitLogger.warn('auto-stage failed; Git rollback safety net may be unavailable', { reason });
  };
  child.on('error', (err) => warnOnce(err instanceof Error ? err.message : String(err)));
  child.on('close', (code) => {
    if (code !== 0) warnOnce(`git add exited with code ${code}`);
  });
}

/**
 * Auto-commit all staged changes (best-effort).
 * Only commits if there are staged changes.
 * T4 (H4): the FIRST failure is surfaced via a debounced logger.warn instead of
 * being silently swallowed.
 */
export async function autoCommitAll(cwd: string, message?: string): Promise<boolean> {
  const commitMessage = (message ?? 'kc-cli auto-commit: turn limit reached').replace(/"/g, "'");
  try {
    await spawnGit('add -A', cwd, 5000);
    const { stdout: diffOutput } = await spawnGit('diff --cached --name-only', cwd, 5000);
    if (diffOutput.trim()) {
      await spawnGit('commit -m "' + commitMessage + '"', cwd, 10000);
      return true;
    }
    return false;
  } catch (err) {
    if (!autoCommitWarned) {
      autoCommitWarned = true;
      gitLogger.warn('auto-commit failed; Git rollback safety net may be unavailable', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
    // Auto-commit failure is non-fatal
    return false;
  }
}

/**
 * Get set of files modified in the working tree (both staged and unstaged).
 * Returns absolute paths relative to cwd.
 */
export async function getModifiedFiles(cwd: string): Promise<string[]> {
  try {
    // Collect staged changes
    const { stdout: staged } = await spawnGit('diff --cached --name-only', cwd, 5000);
    // Collect unstaged changes
    const { stdout: unstaged } = await spawnGit('diff --name-only', cwd, 5000);
    // Collect untracked files
    const { stdout: untracked } = await spawnGit('ls-files --others --exclude-standard', cwd, 5000);

    const files = new Set<string>();
    for (const list of [staged, unstaged, untracked]) {
      for (const f of list.trim().split('\n')) {
        if (f.trim()) files.add(f.trim());
      }
    }
    return Array.from(files);
  } catch {
    return [];
  }
}
