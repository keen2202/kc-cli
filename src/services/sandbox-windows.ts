// Windows Sandbox (WSB) backend for KC-CLI
// Uses Windows Sandbox for container-based isolation on Windows systems.

import type { SandboxBackend, SandboxOptions } from './sandbox';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * WindowsSandbox — uses Windows Sandbox (WSB) for isolation on Windows.
 *
 * Generates a .wsb configuration file and launches the sandbox with the
 * command to execute. Supports:
 * - Network isolation (<Networking>Disable</Networking>)
 * - Folder mapping (<MappedFolders>)
 * - Memory limits (<MemoryInMB>)
 * - Read-only host filesystem access
 */
export class WindowsSandbox implements SandboxBackend {
  readonly name = 'windows-sandbox';

  isAvailable(): boolean {
    if (process.platform !== 'win32') return false;

    try {
      // Check if Windows Sandbox feature is enabled
      // The sandbox executable is typically at C:\Windows\System32\WindowsSandbox.exe
      const sandboxPath = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsSandbox.exe');
      return fs.existsSync(sandboxPath);
    } catch {
      return false;
    }
  }

  wrapCommand(command: string, options: SandboxOptions): string {
    const wsbConfig = this.generateWSBConfig(command, options);
    const configPath = this.writeTempConfig(wsbConfig);

    // Launch Windows Sandbox with the config file
    return `WindowsSandbox.exe "${configPath}"`;
  }

  /**
   * Generate a .wsb XML configuration file content.
   */
  private generateWSBConfig(command: string, options: SandboxOptions): string {
    const escapedCommand = this.escapeXML(command);

    // Build mapped folders: workspace as read-write, system as read-only
    const mappedFolders = [
      // Workspace directory — writable
      `<MappedFolder>
        <HostFolder>${this.escapeXML(options.workDir)}</HostFolder>
        <SandboxFolder>C:\\workspace</SandboxFolder>
        <ReadOnly>false</ReadOnly>
      </MappedFolder>`,
    ];

    // Networking
    const networking = options.allowNetwork
      ? '<Networking>Enable</Networking>'
      : '<Networking>Disable</Networking>';

    // Memory limit
    const memory = options.maxMemoryMb
      ? `<MemoryInMB>${options.maxMemoryMb}</MemoryInMB>`
      : '';

    // The command to run inside the sandbox
    // We use a logon command that runs cmd /c with our command
    const logonCommand = `<LogonCommand>
      <Command>cmd /c ${escapedCommand} &gt; C:\\output.txt 2&gt;&amp;1</Command>
    </LogonCommand>`;

    return `<?xml version="1.0" encoding="UTF-8"?>
<Configuration>
  ${networking}
  ${memory}
  <MappedFolders>
    ${mappedFolders.join('\n    ')}
  </MappedFolders>
  ${logonCommand}
</Configuration>`;
  }

  /**
   * Write the WSB config to a temporary file.
   */
  private writeTempConfig(config: string): string {
    const tmpDir = path.join(os.tmpdir(), 'kc-cli-sandbox');
    fs.mkdirSync(tmpDir, { recursive: true });

    const configPath = path.join(tmpDir, `sandbox-${Date.now()}.wsb`);
    fs.writeFileSync(configPath, config, 'utf-8');

    return configPath;
  }

  /**
   * Escape special XML characters.
   */
  private escapeXML(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }
}
