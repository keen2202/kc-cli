// MockExecutionEnv - In-memory implementation for testing

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

interface MockFile {
  content: string;
  mtime: Date;
}

export class MockFileSystem implements FileSystem {
  private files = new Map<string, MockFile>();

  /** Seed the mock filesystem with initial files. */
  seed(files: Record<string, string>): void {
    for (const [filePath, content] of Object.entries(files)) {
      this.files.set(filePath, { content, mtime: new Date() });
    }
  }

  /** Get all stored file paths (for assertions). */
  listFiles(): string[] {
    return Array.from(this.files.keys());
  }

  async readFile(filePath: string, _encoding?: string): Promise<string> {
    const file = this.files.get(filePath);
    if (!file) {
      throw new Error(`ENOENT: no such file or directory, open '${filePath}'`);
    }
    return file.content;
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    this.files.set(filePath, { content, mtime: new Date() });
  }

  /**
   * T2 (H2): in-memory atomic write. Snapshots any existing file to a
   * timestamped `.bak` key so backup-aware callers/tests behave like the
   * local filesystem without touching disk.
   */
  async writeFileAtomic(
    filePath: string,
    content: string,
    options: AtomicWriteOptions = {},
  ): Promise<AtomicWriteResult> {
    const backup = options.backup ?? true;
    let backupPath: string | null = null;
    const existing = this.files.get(filePath);
    if (backup && existing) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      backupPath = `${filePath}.${ts}.bak`;
      this.files.set(backupPath, { content: existing.content, mtime: new Date() });
    }
    this.files.set(filePath, { content, mtime: new Date() });
    return { backupPath, backupFailed: false };
  }

  async exists(filePath: string): Promise<boolean> {
    return this.files.has(filePath);
  }

  async stat(filePath: string): Promise<FileStat> {
    const file = this.files.get(filePath);
    if (!file) {
      throw new Error(`ENOENT: no such file or directory, stat '${filePath}'`);
    }
    return {
      size: Buffer.byteLength(file.content, 'utf-8'),
      mtime: file.mtime,
      isFile: true,
      isDirectory: false,
    };
  }

  async glob(pattern: string, _cwd: string): Promise<string[]> {
    const GLOB_ESCAPE_REGEX = /[.+^${}()|[\]\\]/g;
    const regexStr = pattern
      .replace(GLOB_ESCAPE_REGEX, '\\$&')
      .replace(/\*\*/g, '___DOUBLE___')
      .replace(/\*/g, '___SINGLE___')
      .replace(/___DOUBLE___/g, '.*')
      .replace(/___SINGLE___/g, '[^/]*')
      .replace(/\?/g, '[^/]');
    const regex = new RegExp(`^${regexStr}$`);
    return Array.from(this.files.keys()).filter(f => regex.test(f));
  }

  async mkdir(_dirPath: string, _options?: { recursive?: boolean }): Promise<void> {
    // No-op for mock - directories are implicit
  }

  async rm(filePath: string, _options?: { recursive?: boolean }): Promise<void> {
    if (!this.files.delete(filePath)) {
      throw new Error(`ENOENT: no such file or directory, rm '${filePath}'`);
    }
  }
}

interface MockCommandHandler {
  (command: string, options: ShellOptions): ShellResult | Promise<ShellResult>;
}

export class MockShell implements Shell {
  private handlers: Array<{ pattern: RegExp; handler: MockCommandHandler }> = [];
  private defaultResult: ShellResult = { stdout: '', stderr: '', exitCode: 0 };
  /** Records all executed commands for assertions. */
  readonly executedCommands: Array<{ command: string; options: ShellOptions }> = [];

  /** Register a handler for commands matching a regex pattern. */
  on(pattern: RegExp, handler: MockCommandHandler): void {
    this.handlers.push({ pattern, handler });
  }

  /** Set the default result for unmatched commands. */
  setDefault(result: ShellResult): void {
    this.defaultResult = result;
  }

  async exec(command: string, options: ShellOptions): Promise<ShellResult> {
    this.executedCommands.push({ command, options });

    for (const { pattern, handler } of this.handlers) {
      if (pattern.test(command)) {
        return handler(command, options);
      }
    }

    return { ...this.defaultResult };
  }
}

export function createMockExecutionEnv(cwd: string = '/mock'): ExecutionEnv {
  return {
    fs: new MockFileSystem(),
    shell: new MockShell(),
    cwd,
  };
}
