// ExecutionEnv abstraction - decouples tools from direct Node.js fs/child_process

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
