// Tests for WebFetchTool protocol validation and edge cases

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as http from 'http';
import * as https from 'https';
import { isInternalUrl } from '../../utils/ssrf';

// Mock the HTTP modules before importing the tool
vi.mock('http', () => {
  const real = vi.importActual('http');
  return {
    ...real as any,
    request: vi.fn(),
  };
});
vi.mock('https', () => {
  const real = vi.importActual('https');
  return {
    ...real as any,
    request: vi.fn(),
  };
});

import { tool } from './index';

describe('WebFetchTool', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('protocol validation', () => {
    it('rejects file:// protocol with clear error', async () => {
      vi.mocked(http.request).mockImplementation((() => {
        throw new Error('Protocol "file:" not supported');
      }) as any);
      const result = await tool.call(
        { url: 'file:///etc/passwd', method: 'GET', max_size: 100000, timeout: 30 },
        {} as any
      );
      expect(result.isError).toBe(true);
      expect(result.message).toContain('file:');
    });

    it('rejects ftp:// protocol with clear error', async () => {
      vi.mocked(http.request).mockImplementation((() => {
        throw new Error('Protocol "ftp:" not supported');
      }) as any);
      const result = await tool.call(
        { url: 'ftp://example.com/file.txt', method: 'GET', max_size: 100000, timeout: 30 },
        {} as any
      );
      expect(result.isError).toBe(true);
      expect(result.message).toContain('ftp:');
    });

    it('does not throw for http:// URLs (mocked)', async () => {
      const mockReq = {
        on: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
        destroy: vi.fn(),
      };
      vi.mocked(http.request).mockImplementation((_url: any, _opts: any, callback: any) => {
        const mockRes = {
          statusCode: 200,
          headers: { 'content-type': 'text/plain' },
          on: vi.fn((event: string, handler: Function) => {
            if (event === 'data') handler('ok');
            if (event === 'end') handler();
          }),
        };
        // Fire callback asynchronously so the Promise resolves
        setTimeout(() => callback(mockRes), 0);
        return mockReq as any;
      });

      const result = await tool.call(
        { url: 'http://example.com', method: 'GET', max_size: 100000, timeout: 30 },
        {} as any
      );
      expect(result.isError).toBeFalsy();
    });
  });

  describe('timeout handling', () => {
    it('uses fallback 30s for NaN timeout input', async () => {
      const mockReq = {
        on: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
        destroy: vi.fn(),
      };
      vi.mocked(http.request).mockImplementation((_url: any, opts: any, callback: any) => {
        // Verify timeout is a valid number (not NaN)
        expect(opts.timeout).toBe(30_000);
        expect(Number.isNaN(opts.timeout)).toBe(false);
        const mockRes = {
          statusCode: 200,
          headers: {},
          on: vi.fn((event: string, handler: Function) => {
            if (event === 'data') handler('');
            if (event === 'end') handler();
          }),
        };
        setTimeout(() => callback(mockRes), 0);
        return mockReq as any;
      });

      await tool.call(
        { url: 'http://example.com', method: 'GET', max_size: 100000, timeout: NaN as any },
        {} as any
      );
      expect(http.request).toHaveBeenCalled();
    });

    it('uses fallback 30s for undefined timeout input', async () => {
      const mockReq = {
        on: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
        destroy: vi.fn(),
      };
      vi.mocked(http.request).mockImplementation((_url: any, opts: any, callback: any) => {
        expect(opts.timeout).toBe(30_000);
        const mockRes = {
          statusCode: 200,
          headers: {},
          on: vi.fn((event: string, handler: Function) => {
            if (event === 'data') handler('');
            if (event === 'end') handler();
          }),
        };
        setTimeout(() => callback(mockRes), 0);
        return mockReq as any;
      });

      await tool.call(
        { url: 'http://example.com', method: 'GET', max_size: 100000, timeout: undefined as any },
        {} as any
      );
      expect(http.request).toHaveBeenCalled();
    });
  });

  describe('[S6] SSRF redirect validation', () => {
    function mockRedirect(location: string) {
      const mockReq = { on: vi.fn(), write: vi.fn(), end: vi.fn(), destroy: vi.fn() };
      vi.mocked(http.request).mockImplementation((_url: any, _opts: any, callback: any) => {
        const mockRes = {
          statusCode: 302,
          headers: { location },
          on: vi.fn(),
        };
        setTimeout(() => callback(mockRes), 0);
        return mockReq as any;
      });
    }

    it('[S6.2] blocks redirect to internal IP (127.0.0.1)', async () => {
      mockRedirect('http://127.0.0.1/admin');
      const result = await tool.call(
        { url: 'http://public.example.com/', method: 'GET', max_size: 100000, timeout: 30 },
        {} as any
      );
      expect(result.isError).toBe(true);
      expect(result.message).toMatch(/ssrf|internal/i);
    });

    it('[S6.2] blocks redirect to 169.254.169.254 (metadata service)', async () => {
      mockRedirect('http://169.254.169.254/latest/meta-data/');
      const result = await tool.call(
        { url: 'http://public.example.com/', method: 'GET', max_size: 100000, timeout: 30 },
        {} as any
      );
      expect(result.isError).toBe(true);
      expect(result.message).toMatch(/ssrf|internal/i);
    });

    it('[S6.1] allows redirect to external host', async () => {
      mockRedirect('http://other-public.example.com/');
      const result = await tool.call(
        { url: 'http://public.example.com/', method: 'GET', max_size: 100000, timeout: 30 },
        {} as any
      );
      expect(result.isError).toBeFalsy();
      expect(result.output).toContain('Redirect to: http://other-public.example.com/');
    });

    it('[S6] blocks relative redirect resolving to internal host', async () => {
      mockRedirect('http://10.0.0.5/internal');
      const result = await tool.call(
        { url: 'http://public.example.com/', method: 'GET', max_size: 100000, timeout: 30 },
        {} as any
      );
      expect(result.isError).toBe(true);
    });
  });
});

describe('isInternalUrl', () => {
  it('detects internal IPv4 ranges', () => {
    expect(isInternalUrl('http://127.0.0.1/')).toBe(true);
    expect(isInternalUrl('http://127.1.2.3/')).toBe(true);
    expect(isInternalUrl('http://10.0.0.1/')).toBe(true);
    expect(isInternalUrl('http://192.168.1.1/')).toBe(true);
    expect(isInternalUrl('http://169.254.169.254/')).toBe(true);
    expect(isInternalUrl('http://172.16.0.1/')).toBe(true);
    expect(isInternalUrl('http://172.31.255.255/')).toBe(true);
    expect(isInternalUrl('http://0.0.0.0/')).toBe(true);
  });

  it('detects 172 outside 16-31 as public', () => {
    expect(isInternalUrl('http://172.15.0.1/')).toBe(false);
    expect(isInternalUrl('http://172.32.0.1/')).toBe(false);
  });

  it('detects internal IPv6', () => {
    expect(isInternalUrl('http://[::1]/')).toBe(true);
    expect(isInternalUrl('http://[fc00::1]/')).toBe(true);
    expect(isInternalUrl('http://[fd12:3456::1]/')).toBe(true);
    expect(isInternalUrl('http://[fe80::1]/')).toBe(true);
  });

  it('detects localhost', () => {
    expect(isInternalUrl('http://localhost/')).toBe(true);
  });

  it('allows public hosts', () => {
    expect(isInternalUrl('http://example.com/')).toBe(false);
    expect(isInternalUrl('http://8.8.8.8/')).toBe(false);
    expect(isInternalUrl('https://github.com/')).toBe(false);
  });

  it('returns false for unparseable input', () => {
    expect(isInternalUrl('not-a-url')).toBe(false);
  });
});
