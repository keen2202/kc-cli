// Sandbox isolation layer for command execution

import { BubblewrapSandbox, SeccompSandbox, NoopSandbox } from './sandbox-profiles';

export interface SandboxOptions {
  /** Whether sandboxing is enabled. When false, commands pass through unchanged. */
  enabled: boolean;
  /** Which backend to use for isolation. */
  backend: 'bubblewrap' | 'seccomp' | 'noop';
  /** The workspace directory to bind as writable. */
  workDir: string;
  /** Whether to allow network access. Default: false (isolated). */
  allowNetwork: boolean;
  /** Maximum memory in MB. Default: 512. */
  maxMemoryMb: number;
  /** CPU time limit in seconds. Default: 60. */
  cpuTimeLimitSec: number;
}

export interface SandboxBackend {
  readonly name: string;
  isAvailable(): boolean;
  wrapCommand(command: string, options: SandboxOptions): string;
}

const DEFAULT_OPTIONS: Omit<SandboxOptions, 'workDir'> = {
  enabled: true,
  backend: 'bubblewrap',
  allowNetwork: false,
  maxMemoryMb: 512,
  cpuTimeLimitSec: 60,
};

const BACKEND_REGISTRY: Record<string, () => SandboxBackend> = {
  bubblewrap: () => new BubblewrapSandbox(),
  seccomp: () => new SeccompSandbox(),
  noop: () => new NoopSandbox(),
};

/**
 * SandboxManager wraps command execution with namespace-based isolation.
 *
 * It selects the best available backend (bubblewrap > seccomp > noop) and
 * delegates command wrapping to that backend.
 */
export class SandboxManager {
  private backend: SandboxBackend;
  private options: SandboxOptions;

  constructor(options: Partial<SandboxOptions> & { workDir: string }) {
    this.options = { ...DEFAULT_OPTIONS, ...options };

    if (!this.options.enabled) {
      this.backend = new NoopSandbox();
      return;
    }

    this.backend = this.resolveBackend(this.options.backend);
  }

  /**
   * Returns true if the selected backend is actually available on this system.
   */
  isAvailable(): boolean {
    return this.backend.isAvailable();
  }

  /**
   * Wrap a raw command string with the sandbox's isolation arguments.
   * If sandboxing is disabled, the command is returned unchanged.
   */
  wrapCommand(command: string): string {
    if (!this.options.enabled) {
      return command;
    }
    return this.backend.wrapCommand(command, this.options);
  }

  /**
   * Get the name of the active backend.
   */
  getBackendName(): string {
    return this.backend.name;
  }

  /**
   * Resolve the requested backend, falling back through the chain
   * bubblewrap -> seccomp -> noop if higher tiers are unavailable.
   */
  private resolveBackend(requested: string): SandboxBackend {
    const fallbackOrder = ['bubblewrap', 'seccomp', 'noop'];
    const startIndex = fallbackOrder.indexOf(requested);

    // Start from the requested backend and fall back
    for (let i = startIndex >= 0 ? startIndex : 0; i < fallbackOrder.length; i++) {
      const factory = BACKEND_REGISTRY[fallbackOrder[i]];
      if (!factory) continue;
      const backend = factory();
      if (backend.isAvailable()) {
        if (i !== startIndex && startIndex >= 0) {
          console.warn(
            `[sandbox] Requested backend "${requested}" is not available, ` +
              `falling back to "${backend.name}"`
          );
        }
        return backend;
      }
    }

    // Ultimate fallback — should never happen since NoopSandbox is always available
    return new NoopSandbox();
  }
}
