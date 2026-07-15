// Sandbox isolation layer for command execution

import { BubblewrapSandbox, SeccompSandbox, NoopSandbox } from './sandbox-profiles';
import { DockerSandbox } from './sandbox-docker';
import { WindowsSandbox } from './sandbox-windows';
import type { SandboxPolicy } from './sandbox-policy';
import { DEFAULT_SANDBOX_POLICY, getToolPolicy, shouldSandbox, mergeSandboxPolicy } from './sandbox-policy';
import { SandboxProbe, type ProbeResult } from './sandbox-probe';
import { SandboxMonitor, type SandboxMetrics, type ResourceLimits } from './sandbox-monitor';
import { ImageManager } from './sandbox-images';
import { logger } from './logger';

export interface SandboxOptions {
  /** Whether sandboxing is enabled. When false, commands pass through unchanged. */
  enabled: boolean;
  /** Which backend to use for isolation. */
  backend: 'bubblewrap' | 'seccomp' | 'docker' | 'noop';
  /** The workspace directory to bind as writable. */
  workDir: string;
  /** Whether to allow network access. Default: false (isolated). */
  allowNetwork: boolean;
  /** Maximum memory in MB. Default: 512. */
  maxMemoryMb: number;
  /** CPU time limit in seconds. Default: 60. */
  cpuTimeLimitSec: number;
  /** If true, throw an error when no real sandbox backend is available instead of falling back to noop. */
  failIfNoSandbox?: boolean;
  /** Per-tool sandbox policy. If not provided, uses DEFAULT_SANDBOX_POLICY. */
  policy?: SandboxPolicy;
  /** Whether to run escape detection probe on startup. Default: true. */
  probeOnStart?: boolean;
  /** Whether to enable runtime resource monitoring. Default: true. */
  enableMonitor?: boolean;
}

export interface SandboxBackend {
  readonly name: string;
  isAvailable(): boolean;
  wrapCommand(command: string, options: SandboxOptions): string;
}

const DEFAULT_OPTIONS: Omit<SandboxOptions, 'workDir' | 'policy'> = {
  enabled: true,
  backend: 'bubblewrap',
  allowNetwork: false,
  maxMemoryMb: 512,
  cpuTimeLimitSec: 60,
  failIfNoSandbox: true,
};

const BACKEND_REGISTRY: Record<string, () => SandboxBackend> = {
  bubblewrap: () => new BubblewrapSandbox(),
  seccomp: () => new SeccompSandbox(),
  docker: () => {
    try {
      return new DockerSandbox();
    } catch {
      return new NoopSandbox();
    }
  },
  'windows-sandbox': () => {
    try {
      return new WindowsSandbox();
    } catch {
      return new NoopSandbox();
    }
  },
  noop: () => new NoopSandbox(),
};

/**
 * SandboxManager wraps command execution with namespace-based isolation.
 *
 * It selects the best available backend (bubblewrap > seccomp > docker > noop)
 * and delegates command wrapping to that backend. Supports per-tool sandbox
 * policies for fine-grained control.
 */
export class SandboxManager {
  private backend: SandboxBackend;
  private options: SandboxOptions;
  private policy: SandboxPolicy;
  private _isAvailable: boolean;
  private probe: SandboxProbe;
  private monitor: SandboxMonitor;
  private imageManager: ImageManager;
  private probeResult: ProbeResult | null = null;

  constructor(options: Partial<SandboxOptions> & { workDir: string }) {
    this.options = { ...DEFAULT_OPTIONS, probeOnStart: true, enableMonitor: true, ...options };
    this.probe = new SandboxProbe();
    this.monitor = new SandboxMonitor();
    this.imageManager = new ImageManager();

    // Build the policy from config sandbox section or use defaults
    const configPolicy = options.policy;
    if (configPolicy) {
      this.policy = configPolicy;
    } else {
      // Build policy from individual sandbox options if no explicit policy
      this.policy = mergeSandboxPolicy({
        enabled: this.options.enabled,
        backend: this.options.backend as SandboxPolicy['backend'],
        allowNetwork: this.options.allowNetwork,
        maxMemoryMb: this.options.maxMemoryMb,
        cpuTimeLimitSec: this.options.cpuTimeLimitSec,
      });
    }

    if (!this.options.enabled || !this.policy.enabled) {
      this.backend = new NoopSandbox();
      this._isAvailable = false;
      return;
    }

    this.backend = this.resolveBackend(this.options.backend);
    // Check availability: noop is NOT considered truly available for 'required' enforcement
    const rawAvailable = this.backend.isAvailable();
    this._isAvailable = rawAvailable && this.backend.name !== 'noop';

    // If no real sandbox backend is available, decide between fail and warn
    if (!this._isAvailable) {
      // Explicit noop means the user intentionally opted out — silent no-op, no warning
      if (this.options.backend === 'noop') {
        // already a NoopSandbox; nothing further to do
      } else if (this.options.failIfNoSandbox) {
        // Hard fail instead of silently running commands on the host (S2: AC-S2.2)
        throw new Error(
          `Sandbox is required but no sandbox backend is available. ` +
            `Requested backend: "${this.options.backend}". ` +
            'Install bubblewrap (bwrap), seccomp, or docker, or disable failIfNoSandbox.'
        );
      } else {
        // Default-deny posture: warn loudly about missing isolation before degrading (S2: AC-S2.1)
        logger.services.warn(
          `[sandbox] ⚠ NO ISOLATION — requested backend "${this.options.backend}" unavailable, ` +
            `falling back to noop; commands will run on the host WITHOUT isolation. ` +
            `Install bubblewrap (apt install bubblewrap), seccomp, or docker, ` +
            `or explicitly opt out with failIfNoSandbox: false or backend: 'noop'.`
        );
      }
      this.backend = new NoopSandbox();
    }

    // Run probe on startup if enabled and a real backend is available
    if (this.options.probeOnStart && this._isAvailable) {
      this.runProbe().catch(err => {
        logger.services.warn(`[sandbox] Probe failed: ${err.message}`);
      });
    }
  }

  /**
   * Returns true if the selected backend is actually available on this system.
   */
  isAvailable(): boolean {
    return this._isAvailable;
  }

  /**
   * Check whether a specific tool should run in the sandbox based on the
   * configured policy and current sandbox availability.
   */
  shouldSandboxTool(toolName: string): 'run-sandboxed' | 'run-unsandboxed' | 'deny' {
    return shouldSandbox(toolName, this._isAvailable, this.policy);
  }

  /**
   * Get the sandbox policy for a specific tool.
   */
  getToolSandboxPolicy(toolName: string) {
    return getToolPolicy(toolName, this.policy);
  }

  /**
   * Wrap a raw command string with the sandbox's isolation arguments.
   * If sandboxing is disabled or the tool is excluded, the command is
   * returned unchanged.
   *
   * @param command The raw command string to wrap
   * @param toolName The name of the tool executing this command (for policy lookup)
   */
  wrapCommand(command: string, toolName?: string): string {
    if (!this.options.enabled || !this.policy.enabled) {
      return command;
    }

    // If tool name is provided, check policy
    if (toolName) {
      const decision = shouldSandbox(toolName, this._isAvailable, this.policy);

      if (decision === 'deny') {
        throw new Error(
          `Tool '${toolName}' requires sandbox but no sandbox backend is available. ` +
            'Install bubblewrap (bwrap) or docker, or add this tool to excluded list.'
        );
      }

      if (decision === 'run-unsandboxed') {
        return command;
      }

      // decision === 'run-sandboxed': apply per-tool overrides
      const toolPolicy = getToolPolicy(toolName, this.policy);
      const toolOptions: SandboxOptions = {
        ...this.options,
        allowNetwork: toolPolicy.allowNetwork,
        maxMemoryMb: toolPolicy.maxMemoryMb,
        cpuTimeLimitSec: toolPolicy.cpuTimeLimitSec,
      };
      return this.backend.wrapCommand(command, toolOptions);
    }

    // No tool name: use global options
    return this.backend.wrapCommand(command, this.options);
  }

  /**
   * Get the name of the active backend.
   */
  getBackendName(): string {
    return this.backend.name;
  }

  /**
   * Get the active sandbox policy.
   */
  getPolicy(): SandboxPolicy {
    return this.policy;
  }

  /**
   * Run isolation verification probe.
   */
  async runProbe(): Promise<ProbeResult> {
    this.probeResult = await this.probe.verifyIsolation(this.backend, this.options);
    if (!this.probeResult.overallPassed) {
      logger.services.warn(
        `[sandbox] Probe detected potential isolation issues: ${this.probeResult.failures.map(f => f.name).join(', ')}`
      );
    }
    return this.probeResult;
  }

  /**
   * Get the cached probe result (if probe was run).
   */
  getProbeResult(): ProbeResult | null {
    return this.probeResult;
  }

  /**
   * Start runtime resource monitoring for a sandboxed process.
   */
  startMonitor(identifier: string | number, backend: 'docker' | 'proc', intervalMs?: number): void {
    if (this.options.enableMonitor !== false) {
      this.monitor.start(identifier, backend, intervalMs);
    }
  }

  /**
   * Stop monitoring and return collected metrics.
   */
  stopMonitor(): SandboxMetrics[] {
    return this.monitor.stop();
  }

  /**
   * Get the latest metrics snapshot.
   */
  getMonitorLatest(): SandboxMetrics | null {
    return this.monitor.getLatest();
  }

  /**
   * Check if current metrics exceed resource limits.
   */
  checkThresholds(): 'ok' | 'warn' | 'kill' {
    return this.monitor.checkThresholds({
      maxMemoryMb: this.options.maxMemoryMb,
      cpuTimeLimitSec: this.options.cpuTimeLimitSec,
    });
  }

  /**
   * Get the image manager for Docker image operations.
   */
  getImageManager(): ImageManager {
    return this.imageManager;
  }

  /**
   * Resolve the requested backend, falling back through the chain
   * bubblewrap -> seccomp -> docker -> noop if higher tiers are unavailable.
   */
  private resolveBackend(requested: string): SandboxBackend {
    const fallbackOrder = ['bubblewrap', 'seccomp', 'docker', 'windows-sandbox', 'noop'];
    const startIndex = fallbackOrder.indexOf(requested);

    // Start from the requested backend and fall back
    for (let i = startIndex >= 0 ? startIndex : 0; i < fallbackOrder.length; i++) {
      const factory = BACKEND_REGISTRY[fallbackOrder[i]];
      if (!factory) continue;
      const backend = factory();
      if (backend.isAvailable()) {
        if (i !== startIndex && startIndex >= 0) {
          logger.services.warn(
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
