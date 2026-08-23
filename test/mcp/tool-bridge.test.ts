// Tests for MCP tool bridge - tests the real convertMCPTool function
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Import the REAL tool-bridge module (no mocking of the module itself)
import {
  convertMCPTool,
  toValidatedToolName,
  validateMCPInputSchema,
  MCP_TOOL_NAME_MAX_LENGTH,
} from '../../src/mcp/tool-bridge';
import type { MCPTool, MCPToolResult } from '../../src/mcp/types';
import type { MCPClientManager } from '../../src/mcp/client-manager';
import { logger } from '../../src/services/logger';

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

// Spy on the real logger.mcp module logger so refusal paths are observable in
// assertions while keeping stderr clean during test runs.
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warnSpy = vi.spyOn(logger.mcp, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

/** Shared assertions for a refused registration (H5). */
async function expectRefused(mcpTool: any, serverId: string, cm: MCPClientManager) {
  const tool = convertMCPTool(mcpTool, serverId, cm);

  expect(tool.isEnabled!()).toBe(false);
  expect(warnSpy).toHaveBeenCalledTimes(1);

  const result = await tool.call({}, {} as any);
  expect(result.isError).toBe(true);
  expect(result.message).toContain('refused');
  expect(cm.callTool).not.toHaveBeenCalled();

  return tool;
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

    it('should refuse registration when schema is null/undefined (H5)', async () => {
      // H5: a missing schema used to fall back to a permissive passthrough
      // schema; the trust boundary now refuses such registrations.
      const mcpTool = {
        name: 'null-schema',
        inputSchema: null as any,
      };
      const cm = createMockClientManager();

      const tool = convertMCPTool(mcpTool, 's', cm);

      expect(tool.isEnabled!()).toBe(false);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(tool.name).toBe('mcp_refused_registration');

      const result = await tool.call({}, {} as any);
      expect(result.isError).toBe(true);
      expect(result.message).toContain('refused');
      expect(cm.callTool).not.toHaveBeenCalled();
    });

    it('should refuse registration for non-object schema type (H5)', () => {
      // H5: only object schemas may cross the trust boundary.
      const mcpTool = {
        name: 'string-schema',
        inputSchema: { type: 'string' } as any,
      };
      const cm = createMockClientManager();

      const tool = convertMCPTool(mcpTool, 's', cm);

      expect(tool.isEnabled!()).toBe(false);
      expect(warnSpy).toHaveBeenCalledTimes(1);
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

// ── H5 / T08: cross-trust-boundary validation ────────────────────────────────

describe('toValidatedToolName (H5 whitelist constructor)', () => {
  it('accepts well-formed composed names', () => {
    expect(toValidatedToolName('server1', 'test-tool')).toBe('mcp_server1_test-tool');
    expect(toValidatedToolName('srv_01', 'get_item-v2')).toBe('mcp_srv_01_get_item-v2');
  });

  it('rejects path separators in server id or tool name', () => {
    expect(toValidatedToolName('../evil', 'tool')).toBeNull();
    expect(toValidatedToolName('srv', 'sub/cmd')).toBeNull();
    expect(toValidatedToolName('srv', '../../etc/passwd')).toBeNull();
  });

  it('rejects dot-dot traversal segments', () => {
    expect(toValidatedToolName('srv', '..')).toBeNull();
    expect(toValidatedToolName('..', 'tool')).toBeNull();
    expect(toValidatedToolName('srv', 'foo..bar')).toBeNull();
  });

  it('rejects unicode characters', () => {
    expect(toValidatedToolName('srv', 'tööl')).toBeNull();
    expect(toValidatedToolName('服务', 'tool')).toBeNull();
    expect(toValidatedToolName('srv', 'emoji🚀')).toBeNull();
  });

  it('rejects control characters and whitespace', () => {
    expect(toValidatedToolName('srv', 'na\u0000me')).toBeNull();
    expect(toValidatedToolName('srv', 'name\n')).toBeNull();
    expect(toValidatedToolName('srv', '\rtab')).toBeNull();
    expect(toValidatedToolName('srv', 'my tool')).toBeNull();
  });

  it('rejects names exceeding the 128-char cap', () => {
    const longName = 'a'.repeat(MCP_TOOL_NAME_MAX_LENGTH); // prefix alone already > cap
    expect(toValidatedToolName('srv', longName)).toBeNull();
  });

  it('accepts names of exactly the maximum length', () => {
    // 'mcp_' (4) + '_' (1) + serverId + toolName === 128
    const maxToolName = 'b'.repeat(MCP_TOOL_NAME_MAX_LENGTH - 5 - 3);
    expect(maxToolName.length + 'srv'.length + 5).toBe(MCP_TOOL_NAME_MAX_LENGTH);
    const composed = toValidatedToolName('srv', maxToolName);
    expect(composed).not.toBeNull();
    expect(composed!.length).toBe(MCP_TOOL_NAME_MAX_LENGTH);
  });
});

describe('validateMCPInputSchema (H5 minimal shape check)', () => {
  it('accepts object schemas with sane properties', () => {
    expect(validateMCPInputSchema({ type: 'object' }).ok).toBe(true);
    expect(
      validateMCPInputSchema({
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      }).ok
    ).toBe(true);
  });

  it('rejects missing/null schemas', () => {
    expect(validateMCPInputSchema(null).ok).toBe(false);
    expect(validateMCPInputSchema(undefined).ok).toBe(false);
  });

  it('rejects non-object schema types and non-object payloads', () => {
    expect(validateMCPInputSchema({ type: 'string' }).ok).toBe(false);
    expect(validateMCPInputSchema('object').ok).toBe(false);
    expect(validateMCPInputSchema([{ type: 'object' }]).ok).toBe(false);
  });

  it('rejects malformed properties and required arrays', () => {
    expect(validateMCPInputSchema({ type: 'object', properties: 'evil' }).ok).toBe(false);
    expect(validateMCPInputSchema({ type: 'object', required: 'query' }).ok).toBe(false);
    expect(validateMCPInputSchema({ type: 'object', required: [42] }).ok).toBe(false);
  });

  it('rejects prototype-polluting property names', () => {
    // JSON.parse produces an OWN '__proto__' key (an object literal would set
    // the prototype instead) — exactly what remote servers can send us.
    const withProto = JSON.parse('{"type":"object","properties":{"__proto__":{}}}');
    expect(validateMCPInputSchema(withProto).ok).toBe(false);
    expect(validateMCPInputSchema({ type: 'object', properties: { constructor: {} } }).ok).toBe(
      false
    );
    expect(validateMCPInputSchema({ type: 'object', properties: { prototype: {} } }).ok).toBe(
      false
    );
  });
});

describe('convertMCPTool trust boundary (H5)', () => {
  it.each([
    ['path separator', 'srv', '../etc/passwd'],
    ['path separator in middle', 'srv', 'sub/cmd'],
    ['dot-dot traversal', 'srv', '..'],
    ['unicode characters', 'srv', 'tööl'],
    ['control character', 'srv', 'na\u0000me'],
  ])('refuses registration for malicious tool name (%s)', async (_label, serverId, toolName) => {
    const cm = createMockClientManager({
      callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'pwned' }] }),
    });
    const mcpTool = { name: toolName, inputSchema: { type: 'object' as const } };

    const tool = await expectRefused(mcpTool, serverId, cm);

    // Refused definitions are inert placeholders — the raw unvalidated name
    // never becomes the registry key.
    expect(tool.name).toBe('mcp_refused_registration');
    expect(tool.description).toContain('refused');
    const warnArg = warnSpy.mock.calls[0][1] as Record<string, unknown>;
    expect(warnArg.serverId).toBe(serverId);
    expect(warnArg.tool).toBe(toolName);
  });

  it('refuses registration for names exceeding the 128-char cap', async () => {
    const cm = createMockClientManager();
    await expectRefused(
      { name: 'x'.repeat(200), inputSchema: { type: 'object' as const } },
      'srv',
      cm
    );
  });

  it('still registers tools whose composed name passes the whitelist', () => {
    const cm = createMockClientManager();
    const tool = convertMCPTool(
      { name: 'valid-tool_1', inputSchema: { type: 'object' } },
      'server-01',
      cm
    );
    expect(tool.name).toBe('mcp_server-01_valid-tool_1');
    expect(tool.isEnabled!()).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('refuses registration when inputSchema is missing', async () => {
    const cm = createMockClientManager({
      callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] }),
    });
    await expectRefused({ name: 'no-schema' }, 'srv', cm);
  });

  it('refuses registration when inputSchema fails minimal shape validation', async () => {
    const cm = createMockClientManager();
    await expectRefused({ name: 'bad-type', inputSchema: { type: 'string' } as any }, 'srv', cm);
  });

  it('refuses registration when properties are malformed', async () => {
    const cm = createMockClientManager();
    await expectRefused(
      { name: 'bad-props', inputSchema: { type: 'object', properties: '__proto__' } as any },
      'srv',
      cm
    );
  });

  it('logs refusals through logger.mcp.warn with identifying context', () => {
    convertMCPTool({ name: '..', inputSchema: { type: 'object' } }, 'srv', createMockClientManager());

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [message, data] = warnSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(message).toContain('Refusing tool registration');
    expect(data).toMatchObject({ serverId: 'srv', tool: '..' });
  });

  it('executes valid tools end-to-end after passing the boundary', async () => {
    const cm = createMockClientManager({
      callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ran' }] }),
    });
    const tool = convertMCPTool(
      { name: 'runner', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
      'srv',
      cm
    );

    const result = await tool.call({ q: 'hello' }, {} as any);

    expect(result.isError).toBe(false);
    expect(result.output).toBe('ran');
    expect(cm.callTool).toHaveBeenCalledWith('srv', 'runner', { q: 'hello' });
  });
});

describe('input safeParse before invocation (H5)', () => {
  const schema: MCPTool['inputSchema'] = {
    type: 'object',
    properties: {
      cmd: { type: 'string' },
      retries: { type: 'integer' },
    },
    required: ['cmd'],
  };

  it('returns a clear error result when inputs fail safeParse', async () => {
    const cm = createMockClientManager({
      callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'never' }] }),
    });
    const tool = convertMCPTool({ name: 'strict', inputSchema: schema }, 'srv', cm);

    const result = await tool.call({ cmd: 42 }, {} as any);

    expect(result.isError).toBe(true);
    expect(result.message).toContain('Invalid input for MCP tool');
    expect(result.message).toContain('cmd');
    expect(cm.callTool).not.toHaveBeenCalled();
  });

  it('reports missing required fields without invoking the server', async () => {
    const cm = createMockClientManager();
    const tool = convertMCPTool({ name: 'strict', inputSchema: schema }, 'srv', cm);

    const result = await tool.call({}, {} as any);

    expect(result.isError).toBe(true);
    expect(result.message).toContain('Invalid input for MCP tool strict');
    expect(cm.callTool).not.toHaveBeenCalled();
  });

  it('forwards safeParsed data to the server on valid input', async () => {
    const cm = createMockClientManager({
      callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] }),
    });
    const tool = convertMCPTool({ name: 'strict', inputSchema: schema }, 'srv', cm);

    const result = await tool.call({ cmd: 'ls', retries: 2, rogue: 'stripped' }, {} as any);

    expect(result.output).toBe('ok');
    expect(cm.callTool).toHaveBeenCalledWith('srv', 'strict', { cmd: 'ls', retries: 2 });
  });
});
