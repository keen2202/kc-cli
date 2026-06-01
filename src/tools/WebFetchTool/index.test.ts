// Tests for WebFetchTool protocol validation and edge cases

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as http from 'http';
import * as https from 'https';

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
});
