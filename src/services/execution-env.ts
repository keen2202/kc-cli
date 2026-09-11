// ExecutionEnv abstraction - decouples tools from direct Node.js fs/child_process
import { AsyncLocalStorage } from 'node:async_hooks';

export interface FileStat {
  size: number;
  mtime: Date;
  isFile: boolean;
  isDirectory: boolean;
}

/** Options for {@link FileSystem.writeFileAtomic} (T2 / H2). */
export interface AtomicWriteOptions {
  /**
   * Workspace root used to locate the `.kc-cli/backups/` directory and compute
   * the backup's relative path. Defaults to `process.cwd()`.
   */
  cwd?: string;
  /** Whether to snapshot an existing target before overwriting. Default true. */
  backup?: boolean;
  /** Maximum number of rolling backups to keep per file. Default 5. */
  maxBackups?: number;
}

/** Result of an atomic write (T2 / H2). */
export interface AtomicWriteResult {
  /**
   * Path to the timestamped backup created before overwrite; null when the
   * target did not exist or backup was disabled.
   */
  backupPath: string | null;
  /**
   * True when a backup was attempted but failed (the write itself still
   * succeeded). Surfaced so callers can mark metadata without aborting.
   */
  backupFailed: boolean;
}

export interface FileSystem {
  readFile(path: string, encoding?: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  /**
   * Atomically write `content` to `path` (temp file in the same directory,
   * then rename) so an interrupted write never leaves a half-written target.
   * Snapshots any existing file to `.kc-cli/backups/` first (best-effort).
   */
  writeFileAtomic(path: string, content: string, options?: AtomicWriteOptions): Promise<AtomicWriteResult>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<FileStat>;
  glob(pattern: string, cwd: string): Promise<string[]>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rm(path: string, options?: { recursive?: boolean }): Promise<void>;
}

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ShellOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
  signal?: AbortSignal;
}

export interface Shell {
  exec(command: string, options: ShellOptions): Promise<ShellResult>;
}

export interface ExecutionEnv {
  fs: FileSystem;
  shell: Shell;
  cwd: string;
  /**
   * Run `fn` holding an exclusive lock for `resolvedPath` (round4 §3-R1).
   *
   * Optional: backends that cannot offer mutual exclusion may omit it, in which
   * case callers fall back to optimistic concurrency — detect that the file
   * changed between read and write, and report a conflict instead of silently
   * overwriting.
   */
  withFileLock?<T>(resolvedPath: string, fn: () => Promise<T>): Promise<T>;
}


// ─── Sub-agent execution tracing (RI-SPEC §3.3) ─────────────────────────

/** Maximum bytes retained from stdout/stderr for one traced command. */
export const TRACE_OUTPUT_MAX_BYTES = 4096;

/** Command execution summary captured inside a sub-agent's ALS scope. */
export interface CommandExecutionSummary {
  command: string;
  exitCode: number;
  /** stdout truncated to {@link TRACE_OUTPUT_MAX_BYTES}. */
  stdout: string;
  /** stderr truncated to {@link TRACE_OUTPUT_MAX_BYTES}. */
  stderr: string;
  cwd?: string;
  timestamp: number;
}

export type FileWriteKind = 'created' | 'modified';

/** A file write observed through an ExecutionEnv. */
export interface FileWriteSummary {
  path: string;
  kind: FileWriteKind;
  timestamp: number;
}

/**
 * Bounded, in-memory trace collected for one sub-agent execution. It never
 * touches disk; it is attached to `SubAgentResult.meta.executionTrace`.
 */
export interface ExecutionTrace {
  commands: CommandExecutionSummary[];
  fileWrites: FileWriteSummary[];
  startedAt: number;
  /** Workspace root used to normalize relative/absolute paths during R4 checks. */
  cwd?: string;
}

const executionTraceStorage = new AsyncLocalStorage<ExecutionTrace>();

/** Create an empty trace (call once per sub-agent run). */
export function createExecutionTrace(cwd?: string): ExecutionTrace {
  return { commands: [], fileWrites: [], startedAt: Date.now(), cwd };
}

/** Run `fn` with `trace` installed as the current AsyncLocalStorage store. */
export async function runWithExecutionTrace<T>(
  trace: ExecutionTrace,
  fn: () => T | Promise<T>,
): Promise<T> {
  return executionTraceStorage.run(trace, async () => fn());
}

/** Read the trace for the current async execution scope (undefined outside a run). */
export function getCurrentExecutionTrace(): ExecutionTrace | undefined {
  return executionTraceStorage.getStore();
}

function truncateTraceText(value: string, maxBytes = TRACE_OUTPUT_MAX_BYTES): string {
  if (value.length === 0) return value;
  const buf = Buffer.from(value, 'utf-8');
  if (buf.length <= maxBytes) return value;
  // Avoid returning a trailing replacement character when the cut lands in
  // the middle of a multi-byte UTF-8 sequence.
  return buf.subarray(0, maxBytes).toString('utf-8').replace(/\uFFFD+$/u, '');
}

/** Record one command result in the active trace, if any. */
export function recordCommandExecution(
  command: string,
  result: ShellResult,
  options: { cwd?: string } = {},
): void {
  const trace = getCurrentExecutionTrace();
  if (!trace) return;
  trace.commands.push({
    command,
    exitCode: typeof result.exitCode === 'number' ? result.exitCode : 1,
    stdout: truncateTraceText(result.stdout ?? ''),
    stderr: truncateTraceText(result.stderr ?? ''),
    cwd: options.cwd,
    timestamp: Date.now(),
  });
}

/** Record one observed file write in the active trace, if any. */
export function recordFileWrite(path: string, kind: FileWriteKind): void {
  const trace = getCurrentExecutionTrace();
  if (!trace) return;
  trace.fileWrites.push({ path, kind, timestamp: Date.now() });
}

/** Marker so traced env wrappers are never applied twice. */
const TRACED_ENV_MARK = Symbol('kc.tracedExecutionEnv');

async function detectWriteKind(env: FileSystem, path: string): Promise<FileWriteKind> {
  try {
    return (await env.exists(path)) ? 'modified' : 'created';
  } catch {
    return 'modified';
  }
}

/**
 * Wrap an ExecutionEnv so Shell/FileSystem writes are recorded into the
 * current execution trace. When no trace is active, methods pass through
 * unchanged (zero behavior change for the foreground agent).
 */
export function createTracedExecutionEnv(env: ExecutionEnv): ExecutionEnv {
  const maybeTraced = env as ExecutionEnv & { [TRACED_ENV_MARK]?: true };
  if (maybeTraced[TRACED_ENV_MARK]) return env;

  // Proxies keep `instanceof` and test doubles intact: e.g.
  // `createMockExecutionEnv().fs instanceof MockFileSystem` remains true while
  // write/exec calls are recorded when a trace is active.
  const fs = new Proxy(env.fs, {
    get(target, prop, receiver) {
      if (prop === 'writeFile') {
        return async (path: string, content: string): Promise<void> => {
          const kind = await detectWriteKind(target, path);
          await target.writeFile(path, content);
          recordFileWrite(path, kind);
        };
      }
      if (prop === 'writeFileAtomic') {
        return async (
          path: string,
          content: string,
          options?: AtomicWriteOptions,
        ): Promise<AtomicWriteResult> => {
          const kind = await detectWriteKind(target, path);
          const result = await target.writeFileAtomic(path, content, options);
          recordFileWrite(path, kind);
          return result;
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as FileSystem;

  const shell = new Proxy(env.shell, {
    get(target, prop, receiver) {
      if (prop === 'exec') {
        return async (command: string, options: ShellOptions): Promise<ShellResult> => {
          const result = await target.exec(command, options);
          recordCommandExecution(command, result, { cwd: options.cwd });
          return result;
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as Shell;

  const traced = new Proxy(env, {
    get(target, prop, receiver) {
      if (prop === 'fs') return fs;
      if (prop === 'shell') return shell;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as ExecutionEnv;

  Object.defineProperty(traced, TRACED_ENV_MARK, { value: true });
  return traced;
}
