// Tests for MCP tool bridge - tests the real convertMCPTool function
import { describe, it, expect, vi } from 'vitest';

// Import the REAL tool-bridge module (no mocking of the module itself)
import { convertMCPTool } from '../../src/mcp/tool-bridge';
import type { MCPTool, MCPToolResult } from '../../src/mcp/types';
import type { MCPClientManager } from '../../src/mcp/client-manager';

function createMockClientManager(overrides: Partial<MCPClientManager> = {}): MCPClientManager {
  return {
    callTool: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    disconnectAll: vi.fn(),
    getStatus: vi.fn(),
    getConnectedServers: vi.fn(),
    getServerTools: vi.fn(),
    getAllTools: vi.fn(),
    healthCheck: vi.fn(),
    getServerInfo: vi.fn(),
    ...overrides,
  } as unknown as MCPClientManager;
}

describe('convertMCPTool', () => {
  it('should convert a basic MCP tool to ToolDefinition', () => {
    const mcpTool: MCPTool = {
      name: 'test-tool',
      description: 'A test tool',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
        },
        required: ['query'],
      },
    };

    const cm = createMockClientManager();
    const result = convertMCPTool(mcpTool, 'server1', cm);

    expect(result.name).toBe('mcp_server1_test-tool');
    expect(result.description).toContain('[MCP:server1]');
    expect(result.description).toContain('A test tool');
  });

  it('should use tool name as description fallback', () => {
    const mcpTool: MCPTool = {
      name: 'no-desc-tool',
      inputSchema: { type: 'object' },
    };

    const cm = createMockClientManager();
    const result = convertMCPTool(mcpTool, 's1', cm);

    expect(result.description).toContain('no-desc-tool');
  });

  it('should call clientManager.callTool on invocation', async () => {
    const mcpTool: MCPTool = {
      name: 'exec',
      description: 'Execute something',
      inputSchema: { type: 'object', properties: { cmd: { type: 'string' } } },
    };

    const toolResult: MCPToolResult = {
      content: [{ type: 'text', text: 'result text' }],
    };

    const cm = createMockClientManager({
      callTool: vi.fn().mockResolvedValue(toolResult),
    });

    const tool = convertMCPTool(mcpTool, 'srv', cm);
    const result = await tool.call({ cmd: 'test' }, {} as any);

    expect(cm.callTool).toHaveBeenCalledWith('srv', 'exec', { cmd: 'test' });
    expect(result.output).toBe('result text');
    expect(result.isError).toBe(false);
  });

  it('should return toolError when MCP result has isError', async () => {
    const mcpTool: MCPTool = {
      name: 'fail-tool',
      inputSchema: { type: 'object' },
    };

    const toolResult: MCPToolResult = {
      content: [{ type: 'text', text: 'something failed' }],
      isError: true,
    };

    const cm = createMockClientManager({
      callTool: vi.fn().mockResolvedValue(toolResult),
    });

    const tool = convertMCPTool(mcpTool, 'srv', cm);
    const result = await tool.call({}, {} as any);

    expect(result.isError).toBe(true);
  });

  it('should handle clientManager.callTool throwing', async () => {
    const mcpTool: MCPTool = {
      name: 'throw-tool',
      inputSchema: { type: 'object' },
    };

    const cm = createMockClientManager({
      callTool: vi.fn().mockRejectedValue(new Error('Connection lost')),
    });

    const tool = convertMCPTool(mcpTool, 'srv', cm);
    const result = await tool.call({}, {} as any);

    expect(result.isError).toBe(true);
    expect(result.message).toContain('Connection lost');
  });

  it('should handle non-Error exceptions from callTool', async () => {
    const mcpTool: MCPTool = {
      name: 'throw-string',
      inputSchema: { type: 'object' },
    };

    const cm = createMockClientManager({
      callTool: vi.fn().mockRejectedValue('string error'),
    });

    const tool = convertMCPTool(mcpTool, 'srv', cm);
    const result = await tool.call({}, {} as any);

    expect(result.isError).toBe(true);
    expect(result.message).toContain('string error');
  });

  describe('formatMCPToolResult', () => {
    it('should format text content', async () => {
      const mcpTool: MCPTool = { name: 't', inputSchema: { type: 'object' } };
      const cm = createMockClientManager({
        callTool: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: 'hello' }],
        }),
      });

      const tool = convertMCPTool(mcpTool, 's', cm);
      const result = await tool.call({}, {} as any);
      expect(result.output).toBe('hello');
    });

    it('should format image content', async () => {
      const mcpTool: MCPTool = { name: 't', inputSchema: { type: 'object' } };
      const cm = createMockClientManager({
        callTool: vi.fn().mockResolvedValue({
          content: [{ type: 'image', data: 'base64...', mimeType: 'image/png' }],
        }),
      });

      const tool = convertMCPTool(mcpTool, 's', cm);
      const result = await tool.call({}, {} as any);
      expect(result.output).toBe('[Image: image/png]');
    });

    it('should format resource content', async () => {
      const mcpTool: MCPTool = { name: 't', inputSchema: { type: 'object' } };
      const cm = createMockClientManager({
        callTool: vi.fn().mockResolvedValue({
          content: [{ type: 'resource', resource: { uri: 'file:///test.txt' } }],
        }),
      });

      const tool = convertMCPTool(mcpTool, 's', cm);
      const result = await tool.call({}, {} as any);
      expect(result.output).toBe('[Resource: file:///test.txt]');
    });

    it('should join multiple content items with newlines', async () => {
      const mcpTool: MCPTool = { name: 't', inputSchema: { type: 'object' } };
      const cm = createMockClientManager({
        callTool: vi.fn().mockResolvedValue({
          content: [
            { type: 'text', text: 'line1' },
            { type: 'text', text: 'line2' },
          ],
        }),
      });

      const tool = convertMCPTool(mcpTool, 's', cm);
      const result = await tool.call({}, {} as any);
      expect(result.output).toBe('line1\nline2');
    });
  });

  describe('jsonSchemaToZod', () => {
    it('should handle schema with no properties', async () => {
      const mcpTool: MCPTool = {
        name: 'no-props',
        inputSchema: { type: 'object' },
      };
      const cm = createMockClientManager({
        callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] }),
      });

      const tool = convertMCPTool(mcpTool, 's', cm);
      const result = await tool.call({ any: 'data' }, {} as any);
      expect(result.output).toBe('ok');
    });

    it('should handle null/undefined schema', async () => {
      const mcpTool = {
        name: 'null-schema',
        inputSchema: null as any,
      };
      const cm = createMockClientManager({
        callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] }),
      });

      const tool = convertMCPTool(mcpTool, 's', cm);
      const result = await tool.call({}, {} as any);
      expect(result.output).toBe('ok');
    });

    it('should handle non-object schema type', async () => {
      const mcpTool = {
        name: 'string-schema',
        inputSchema: { type: 'string' } as any,
      };
      const cm = createMockClientManager({
        callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] }),
      });

      const tool = convertMCPTool(mcpTool, 's', cm);
      const result = await tool.call({}, {} as any);
      expect(result.output).toBe('ok');
    });

    it('should handle various property types', async () => {
      const mcpTool: MCPTool = {
        name: 'typed',
        inputSchema: {
          type: 'object',
          properties: {
            str: { type: 'string' },
            num: { type: 'number' },
            bool: { type: 'boolean' },
            int: { type: 'integer' },
            arr: { type: 'array' },
            obj: { type: 'object' },
            unknown: { type: 'null' } as any,
          },
          required: ['str', 'num'],
        },
      };

      const cm = createMockClientManager({
        callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] }),
      });

      const tool = convertMCPTool(mcpTool, 's', cm);
      const result = await tool.call({
        str: 'hello',
        num: 42,
        bool: true,
        int: 7,
        arr: [1, 2],
        obj: { a: 1 },
        unknown: 'x',
      }, {} as any);

      expect(result.output).toBe('ok');
    });

    it('should handle properties with descriptions', async () => {
      const mcpTool: MCPTool = {
        name: 'desc-props',
        inputSchema: {
          type: 'object',
          properties: {
            param: { type: 'string', description: 'A described param' },
          },
        },
      };

      const cm = createMockClientManager({
        callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] }),
      });

      const tool = convertMCPTool(mcpTool, 's', cm);
      const result = await tool.call({ param: 'test' }, {} as any);
      expect(result.output).toBe('ok');
    });
  });

  describe('tool metadata methods', () => {
    it('should return correct permission check', () => {
      const mcpTool: MCPTool = { name: 'my-tool', inputSchema: { type: 'object' } };
      const cm = createMockClientManager();
      const tool = convertMCPTool(mcpTool, 'srv', cm);

      const perm = tool.checkPermissions!({} as any, {} as any);
      expect(perm.behavior).toBe('ask');
      expect((perm as any).message).toContain('my-tool');
      expect((perm as any).message).toContain('srv');
    });

    it('should report not read-only', () => {
      const mcpTool: MCPTool = { name: 't', inputSchema: { type: 'object' } };
      const cm = createMockClientManager();
      const tool = convertMCPTool(mcpTool, 's', cm);
      expect(tool.isReadOnly!()).toBe(false);
    });

    it('should report concurrency safe', () => {
      const mcpTool: MCPTool = { name: 't', inputSchema: { type: 'object' } };
      const cm = createMockClientManager();
      const tool = convertMCPTool(mcpTool, 's', cm);
      expect(tool.isConcurrencySafe!()).toBe(true);
    });

    it('should report not destructive', () => {
      const mcpTool: MCPTool = { name: 't', inputSchema: { type: 'object' } };
      const cm = createMockClientManager();
      const tool = convertMCPTool(mcpTool, 's', cm);
      expect(tool.isDestructive!()).toBe(false);
    });

    it('should generate prompt text', () => {
      const mcpTool: MCPTool = { name: 't', inputSchema: { type: 'object' } };
      const cm = createMockClientManager();
      const tool = convertMCPTool(mcpTool, 's', cm);
      const prompt = tool.prompt!({ input: {} } as any);
      expect(prompt).toContain('t');
      expect(prompt).toContain('s');
    });

    it('should generate tool use summary', () => {
      const mcpTool: MCPTool = { name: 't', inputSchema: { type: 'object' } };
      const cm = createMockClientManager();
      const tool = convertMCPTool(mcpTool, 's', cm);
      const summary = tool.getToolUseSummary!({ key: 'val' });
      expect(summary).toContain('mcp:s/t');
    });

    it('should generate activity description', () => {
      const mcpTool: MCPTool = { name: 't', inputSchema: { type: 'object' } };
      const cm = createMockClientManager();
      const tool = convertMCPTool(mcpTool, 's', cm);
      const desc = tool.getActivityDescription!({});
      expect(desc).toContain('t');
      expect(desc).toContain('s');
    });
  });
});
