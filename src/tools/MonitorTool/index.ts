// Monitor Tool - System monitoring (CPU, memory, disk, processes)

import { z } from 'zod';
import { buildTool, toolResult, toolError } from '../../Tool';
import type { ToolResult as ToolResultType } from '../../types/tools';
import type { PermissionResult } from '../../types/permissions';
import * as os from 'os';

const MonitorInputSchema = z.object({
  metric: z.enum(['cpu', 'memory', 'disk', 'processes', 'network', 'all']).default('all').describe('Metric to monitor'),
});

type MonitorInput = z.infer<typeof MonitorInputSchema>;

export const tool = buildTool<MonitorInput, string>({
  name: 'Monitor',
  description: 'Monitor system resources',

  inputSchema: MonitorInputSchema,

  call: async (input, context): Promise<ToolResultType<string>> => {
    try {
      const results: string[] = [];

      if (input.metric === 'all' || input.metric === 'cpu') {
        const cpus = os.cpus();
        const loadAvg = os.loadavg();
        results.push(
          `CPU:
  Model: ${cpus[0]?.model || 'Unknown'}
  Cores: ${cpus.length}
  Load Average: ${loadAvg.map(l => l.toFixed(2)).join(', ')}
  Usage: ${((1 - os.freemem() / os.totalmem()) * 100).toFixed(1)}%`
        );
      }

      if (input.metric === 'all' || input.metric === 'memory') {
        const totalMemGb = os.totalmem() / 1024 / 1024 / 1024;
        const freeMemGb = os.freemem() / 1024 / 1024 / 1024;
        const usedMemGb = totalMemGb - freeMemGb;
        const totalMem = totalMemGb.toFixed(2);
        const freeMem = freeMemGb.toFixed(2);
        const usedMem = usedMemGb.toFixed(2);
        results.push(
          `Memory:
  Total: ${totalMem} GB
  Used: ${usedMem} GB
  Free: ${freeMem} GB
  Usage: ${((1 - os.freemem() / os.totalmem()) * 100).toFixed(1)}%`
        );
      }

      if (input.metric === 'all' || input.metric === 'disk') {
        results.push(
          `Disk:
  Platform: ${os.platform()}
  Architecture: ${os.arch()}
  Hostname: ${os.hostname()}`
        );
      }

      if (input.metric === 'all' || input.metric === 'network') {
        const networkInterfaces = os.networkInterfaces();
        // Single-pass: filter + map combined into flatMap
        const interfaces = Object.entries(networkInterfaces)
          .flatMap(([name, ifaces]) => {
            if (!ifaces || ifaces.length === 0) return [];
            const iface = ifaces[0];
            return [`  ${name}: ${iface?.address} (${iface?.mac})`];
          })
          .join('\n');
        results.push(`Network Interfaces:\n${interfaces}`);
      }

      if (input.metric === 'processes') {
        results.push(
          `Processes:
  PID: ${process.pid}
  Uptime: ${(process.uptime() / 60).toFixed(1)} minutes
  Memory: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)} MB`
        );
      }

      return toolResult(results.join('\n\n'), {
        metadata: {
          metric: input.metric,
          timestamp: Date.now(),
          platform: os.platform(),
        },
      });
    } catch (error) {
      return toolError(`Monitor failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  },

  checkPermissions: (): PermissionResult => ({
    behavior: 'allow',
    updatedInput: {},
    decisionReason: { type: 'readonly', reason: 'System monitoring is read-only' },
  }),

  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  prompt: () => 'Monitor system resources (CPU, memory, disk, etc).',

  getToolUseSummary: (input) => `Monitoring: ${input.metric}`,
  getActivityDescription: (input) => `Checking ${input.metric} metrics`,
});
