// ExecutionEnv abstraction - decouples tools from direct Node.js fs/child_process

export interface FileStat {
  size: number;
  mtime: Date;
  isFile: boolean;
  isDirectory: boolean;
}

export interface FileSystem {
  readFile(path: string, encoding?: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
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
}
