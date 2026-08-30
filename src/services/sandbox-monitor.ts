// Sandbox runtime resource monitoring
// Tracks memory, CPU, wall time, and network usage during sandboxed command execution.

import { execSync } from 'child_process';
import { SANDBOX_MONITOR_SNAPSHOT_TIMEOUT_MS, SANDBOX_MONITOR_POLL_TIMEOUT_MS } from '../constants';

export interface SandboxMetrics {
  memoryUsageMb: number;
  cpuPercent: number;
  wallTimeMs: number;
  networkBytesIn: number;
  networkBytesOut: number;
}

export interface ResourceLimits {
  maxMemoryMb: number;
  cpuTimeLimitSec: number;
}

export type ThresholdStatus = 'ok' | 'warn' | 'kill';

export class SandboxMonitor {
  private interval: NodeJS.Timeout | null = null;
  private metrics: SandboxMetrics[] = [];
  private startTime = 0;
  private containerId: string | null = null;
  private pid: number | null = null;
  private backend: 'docker' | 'proc' = 'proc';
  private static readonly MAX_METRICS = 300; // Cap at 5 minutes of 1s intervals

  /**
   * Start monitoring a sandboxed process/container.
   * @param identifier Container ID (Docker) or PID (bubblewrap/seccomp)
   * @param backend Which backend to use for metrics collection
   * @param intervalMs Polling interval in milliseconds
   */
  start(identifier: string | number, backend: 'docker' | 'proc', intervalMs = 1000): void {
    this.stop(); // Clear any existing monitor
    this.metrics = [];
    this.startTime = Date.now();
    this.backend = backend;

    if (backend === 'docker') {
      this.containerId = String(identifier);
      this.pid = null;
    } else {
      this.pid = Number(identifier);
      this.containerId = null;
    }

    this.interval = setInterval(() => {
      this.collectMetrics();
    }, intervalMs);

    // Collect initial metrics
    this.collectMetrics();
  }

  /**
   * Stop monitoring and return all collected metrics.
   */
  stop(): SandboxMetrics[] {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.containerId = null;
      this.pid = null;
    return [...this.metrics];
  }

  /**
   * Get the latest metrics snapshot.
   */
  getLatest(): SandboxMetrics | null {
    return this.metrics.length > 0 ? this.metrics[this.metrics.length - 1] : null;
  }

  /**
   * Get all collected metrics.
   */
  getAll(): SandboxMetrics[] {
    return [...this.metrics];
  }

  /**
   * Check if current metrics exceed resource limits.
   */
  checkThresholds(limits: ResourceLimits): ThresholdStatus {
    const latest = this.getLatest();
    if (!latest) return 'ok';

    // Kill if memory exceeds 110% of limit
    if (latest.memoryUsageMb > limits.maxMemoryMb * 1.1) {
      return 'kill';
    }

    // Warn if memory exceeds 90% of limit
    if (latest.memoryUsageMb > limits.maxMemoryMb * 0.9) {
      return 'warn';
    }

    // Kill if CPU exceeds 95%
    if (latest.cpuPercent > 95) {
      return 'kill';
    }

    // Warn if wall time exceeds 80% of CPU time limit
    if (latest.wallTimeMs > limits.cpuTimeLimitSec * 1000 * 0.8) {
      return 'warn';
    }

    return 'ok';
  }

  private collectMetrics(): void {
    try {
      const metrics = this.backend === 'docker' && this.containerId
        ? this.collectDockerMetrics(this.containerId)
        : this.pid !== null
          ? this.collectProcMetrics(this.pid)
          : null;

      if (metrics) {
        metrics.wallTimeMs = Date.now() - this.startTime;
        // Cap metrics array to prevent unbounded growth in long-running sandboxes
        if (this.metrics.length >= SandboxMonitor.MAX_METRICS) {
          this.metrics.splice(0, this.metrics.length - SandboxMonitor.MAX_METRICS + 1);
        }
        this.metrics.push(metrics);
      }
    } catch {
      // Metrics collection failed — process may have exited
    }
  }

  private collectDockerMetrics(containerId: string): SandboxMetrics | null {
    try {
      const output = execSync(
        `docker stats --no-stream --format "{{.MemUsage}}|{{.CPUPerc}}|{{.NetIO}}" ${containerId}`,
        { encoding: 'utf-8', timeout: SANDBOX_MONITOR_SNAPSHOT_TIMEOUT_MS }
      ).trim();

      const [memPart, cpuPart, netPart] = output.split('|');
      if (!memPart || !cpuPart) return null;

      // Parse memory: "123.4MiB / 512MiB" -> 123.4
      const memMatch = memPart.match(/([\d.]+)\s*(MiB|GiB|KiB)/i);
      let memoryUsageMb = 0;
      if (memMatch) {
        const val = parseFloat(memMatch[1]);
        const unit = memMatch[2].toLowerCase();
        if (unit === 'gib') memoryUsageMb = val * 1024;
        else if (unit === 'kib') memoryUsageMb = val / 1024;
        else memoryUsageMb = val;
      }

      // Parse CPU: "12.34%" -> 12.34
      const cpuMatch = cpuPart.match(/([\d.]+)%/);
      const cpuPercent = cpuMatch ? parseFloat(cpuMatch[1]) : 0;

      // Parse network: "1.23kB / 4.56kB"
      let networkBytesIn = 0;
      let networkBytesOut = 0;
      if (netPart) {
        const netMatch = netPart.match(/([\d.]+)\s*(B|kB|MB|GB)\s*\/\s*([\d.]+)\s*(B|kB|MB|GB)/i);
        if (netMatch) {
          networkBytesIn = this.parseBytes(parseFloat(netMatch[1]), netMatch[2]);
          networkBytesOut = this.parseBytes(parseFloat(netMatch[3]), netMatch[4]);
        }
      }

      return { memoryUsageMb, cpuPercent, wallTimeMs: 0, networkBytesIn, networkBytesOut };
    } catch {
      return null;
    }
  }

  private collectProcMetrics(pid: number): SandboxMetrics | null {
    try {
      // Read /proc/[pid]/stat for CPU info
      const stat = execSync(`cat /proc/${pid}/stat 2>/dev/null`, {
        encoding: 'utf-8',
        timeout: SANDBOX_MONITOR_POLL_TIMEOUT_MS,
      }).trim();

      // Parse stat fields: pid (comm) state ppid pgrp session tty_nr tpgi flags
      // utime stime cutime cstime ...
      const fields = stat.split(/\s+/);
      const utime = parseInt(fields[13], 10) || 0;
      const stime = parseInt(fields[14], 10) || 0;

      // Get system clock ticks (usually 100)
      const clockTicks = 100;
      const cpuSeconds = (utime + stime) / clockTicks;
      const wallTimeMs = Date.now() - this.startTime;
      const cpuPercent = wallTimeMs > 0 ? (cpuSeconds / (wallTimeMs / 1000)) * 100 : 0;

      // Read memory from /proc/[pid]/status
      let memoryUsageMb = 0;
      try {
        const status = execSync(`grep VmRSS /proc/${pid}/status 2>/dev/null`, {
          encoding: 'utf-8',
          timeout: SANDBOX_MONITOR_POLL_TIMEOUT_MS,
        }).trim();
        const memMatch = status.match(/VmRSS:\s+(\d+)\s+kB/);
        if (memMatch) {
          memoryUsageMb = parseInt(memMatch[1], 10) / 1024;
        }
      } catch {
        // Memory read failed
      }

      return {
        memoryUsageMb,
        cpuPercent: Math.min(cpuPercent, 100),
        wallTimeMs: 0,
        networkBytesIn: 0,
        networkBytesOut: 0,
      };
    } catch {
      return null;
    }
  }

  private parseBytes(value: number, unit: string): number {
    const u = unit.toLowerCase();
    if (u === 'gb') return value * 1024 * 1024 * 1024;
    if (u === 'mb') return value * 1024 * 1024;
    if (u === 'kb' || u === 'kib') return value * 1024;
    return value;
  }
}
