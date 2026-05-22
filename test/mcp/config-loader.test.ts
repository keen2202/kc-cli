// Tests for MCP config loader - tests the real loadMCPConfig function
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';

// Mock only the I/O boundary (fs and os)
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    promises: {
      ...actual.promises,
      readFile: vi.fn(),
    },
  };
});

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return {
    ...actual,
    homedir: vi.fn(() => '/home/testuser'),
  };
});

// Import the REAL config-loader module
import { loadMCPConfig } from '../../src/mcp/config-loader';

describe('loadMCPConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return empty config when no files exist', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const result = await loadMCPConfig('/project');

    expect(result.servers).toEqual({});
    expect(result.sources).toEqual([]);
  });

  it('should load project-level .mcp.json', async () => {
    vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
      return String(p) === '/project/.mcp.json';
    });

    vi.mocked(fs.promises.readFile).mockResolvedValue(JSON.stringify({
      mcpServers: {
        'my-server': {
          type: 'stdio',
          command: 'mcp-server',
          args: ['--verbose'],
        },
      },
    }));

    const result = await loadMCPConfig('/project');

    expect(result.servers).toHaveProperty('my-server');
    expect(result.servers['my-server'].type).toBe('stdio');
    expect(result.servers['my-server'].command).toBe('mcp-server');
    expect(result.sources).toContain('/project/.mcp.json');
  });

  it('should load user-global ~/.kc-cli/mcp.json', async () => {
    vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
      return String(p) === '/home/testuser/.kc-cli/mcp.json';
    });

    vi.mocked(fs.promises.readFile).mockResolvedValue(JSON.stringify({
      mcpServers: {
        'global-server': {
          type: 'http',
          url: 'http://localhost:8080',
        },
      },
    }));

    const result = await loadMCPConfig('/project');

    expect(result.servers).toHaveProperty('global-server');
    expect(result.sources).toContain('/home/testuser/.kc-cli/mcp.json');
  });

  it('should merge user and project configs with project overriding', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);

    vi.mocked(fs.promises.readFile).mockImplementation(async (p: fs.PathOrFileDescriptor) => {
      if (String(p).includes('.kc-cli')) {
        return JSON.stringify({
          mcpServers: {
            'shared-server': { type: 'stdio', command: 'global-cmd' },
            'global-only': { type: 'http', url: 'http://global' },
          },
        });
      }
      return JSON.stringify({
        mcpServers: {
          'shared-server': { type: 'stdio', command: 'project-cmd' },
          'project-only': { type: 'stdio', command: 'proj' },
        },
      });
    });

    const result = await loadMCPConfig('/project');

    expect(result.servers['shared-server'].command).toBe('project-cmd');
    expect(result.servers).toHaveProperty('global-only');
    expect(result.servers).toHaveProperty('project-only');
    expect(result.sources).toHaveLength(2);
  });

  it('should filter out disabled servers', async () => {
    vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
      return String(p) === '/project/.mcp.json';
    });

    vi.mocked(fs.promises.readFile).mockResolvedValue(JSON.stringify({
      mcpServers: {
        'active-server': { type: 'stdio', command: 'cmd1' },
        'disabled-server': { type: 'stdio', command: 'cmd2', enabled: false },
      },
    }));

    const result = await loadMCPConfig('/project');

    expect(result.servers).toHaveProperty('active-server');
    expect(result.servers).not.toHaveProperty('disabled-server');
  });

  it('should handle invalid JSON gracefully', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.promises.readFile).mockResolvedValue('not valid json{{{'  );

    const result = await loadMCPConfig('/project');

    expect(result.servers).toEqual({});
  });

  it('should handle file read errors', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.promises.readFile).mockRejectedValue(new Error('Permission denied'));

    const result = await loadMCPConfig('/project');

    expect(result.servers).toEqual({});
  });

  it('should handle missing mcpServers field', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.promises.readFile).mockResolvedValue(JSON.stringify({
      someOtherField: 'value',
    }));

    const result = await loadMCPConfig('/project');

    expect(result.servers).toEqual({});
  });

  it('should handle null mcpServers field', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.promises.readFile).mockResolvedValue(JSON.stringify({
      mcpServers: null,
    }));

    const result = await loadMCPConfig('/project');

    expect(result.servers).toEqual({});
  });
});
