import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FeishuAdapter } from './feishu';
import type { IMAdapterConfig, IMMessage } from '../protocol';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock WebSocket
class MockWebSocket {
  static instances: MockWebSocket[] = [];
  readyState = 1; // OPEN
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((err: Error) => void) | null = null;
  send = vi.fn();
  close = vi.fn();

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
    // Auto-trigger onopen
    setTimeout(() => this.onopen?.(), 0);
  }

  // Simulate receiving a message
  _simulateMessage(data: string) {
    this.onmessage?.({ data });
  }

  // Simulate close
  _simulateClose(code = 1000, reason = '') {
    this.onclose?.({ code, reason });
  }

  // Simulate error
  _simulateError(err: Error) {
    this.onerror?.(err);
  }
}

vi.stubGlobal('WebSocket', MockWebSocket);

const testConfig: IMAdapterConfig = {
  enabled: true,
  appId: 'test-app-id',
  appSecret: 'test-app-secret',
};

describe('FeishuAdapter', () => {
  let adapter: FeishuAdapter;

  beforeEach(() => {
    MockWebSocket.instances = [];
    mockFetch.mockReset();

    // Default token response
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('app_access_token')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            app_access_token: 'test-token',
            expire: 7200,
            code: 0,
            msg: 'ok',
          }),
        });
      }
      // Default success for message sending
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ code: 0, msg: 'ok' }),
      });
    });

    adapter = new FeishuAdapter(testConfig);
  });

  afterEach(async () => {
    await adapter.disconnect();
    vi.restoreAllMocks();
  });

  describe('connect', () => {
    it('should obtain token and connect WebSocket', async () => {
      await adapter.connect();

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('app_access_token'),
        expect.objectContaining({ method: 'POST' })
      );
      expect(MockWebSocket.instances).toHaveLength(1);
      expect(adapter.isConnected()).toBe(true);
    });

    it('should throw on token failure', async () => {
      mockFetch.mockImplementationOnce(() => Promise.resolve({
        ok: false,
        status: 401,
        text: () => Promise.resolve('Unauthorized'),
      }));

      await expect(adapter.connect()).rejects.toThrow();
    });
  });

  describe('disconnect', () => {
    it('should close WebSocket connection', async () => {
      await adapter.connect();
      const ws = MockWebSocket.instances[0];

      await adapter.disconnect();

      expect(ws.close).toHaveBeenCalledWith(1000, 'shutdown');
      expect(adapter.isConnected()).toBe(false);
    });
  });

  describe('sendMessage', () => {
    it('should send text message via REST API', async () => {
      await adapter.connect();

      const message: IMMessage = {
        id: 'msg-1',
        platform: 'feishu',
        direction: 'outbound',
        channelType: 'user',
        channelId: 'open-id-123',
        senderId: 'kc-cli',
        content: { type: 'text', text: 'Hello from KC-CLI' },
        timestamp: Date.now(),
      };

      await adapter.sendMessage(message);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/im/v1/messages'),
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Authorization': 'Bearer test-token',
          }),
          body: expect.stringContaining('Hello from KC-CLI'),
        })
      );
    });

    it('should throw when circuit breaker is open', async () => {
      await adapter.connect();

      // Trigger multiple failures to open circuit breaker
      mockFetch.mockImplementation(() => Promise.resolve({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Server Error'),
      }));

      const message: IMMessage = {
        id: 'msg-1',
        platform: 'feishu',
        direction: 'outbound',
        channelType: 'user',
        channelId: 'open-id-123',
        senderId: 'kc-cli',
        content: { type: 'text', text: 'Test' },
        timestamp: Date.now(),
      };

      // Fail 5 times to open circuit breaker
      for (let i = 0; i < 5; i++) {
        await adapter.sendMessage(message).catch(err => { console.error('[FeishuAdapter test] sendMessage failed', err); });
      }

      // Now circuit should be open
      await expect(adapter.sendMessage(message)).rejects.toThrow('circuit breaker');
    });
  });

  describe('onMessage', () => {
    it('should parse inbound text messages', async () => {
      await adapter.connect();
      const ws = MockWebSocket.instances[0];

      const receivedMessages: IMMessage[] = [];
      adapter.onMessage((msg) => receivedMessages.push(msg));

      // Simulate Feishu WebSocket event
      const feishuEvent = {
        header: {
          event_type: 'im.message.receive_v1',
        },
        event: {
          message: {
            message_id: 'msg-123',
            message_type: 'text',
            content: JSON.stringify({ text: 'Hello Bot' }),
            chat_id: 'chat-456',
            chat_type: 'group',
            create_time: '1700000000000',
          },
          sender: {
            sender_id: {
              open_id: 'user-789',
              name: 'Test User',
            },
          },
        },
      };

      ws._simulateMessage(JSON.stringify(feishuEvent));

      expect(receivedMessages).toHaveLength(1);
      expect(receivedMessages[0].content).toEqual({ type: 'text', text: 'Hello Bot' });
      expect(receivedMessages[0].channelType).toBe('group');
      expect(receivedMessages[0].channelId).toBe('chat-456');
      expect(receivedMessages[0].senderId).toBe('user-789');
    });

    it('should handle p2p (direct message) chat type', async () => {
      await adapter.connect();
      const ws = MockWebSocket.instances[0];

      const receivedMessages: IMMessage[] = [];
      adapter.onMessage((msg) => receivedMessages.push(msg));

      const feishuEvent = {
        header: { event_type: 'im.message.receive_v1' },
        event: {
          message: {
            message_id: 'msg-124',
            message_type: 'text',
            content: JSON.stringify({ text: 'Direct message' }),
            chat_type: 'p2p',
            create_time: '1700000000000',
          },
          sender: {
            sender_id: {
              open_id: 'user-abc',
              name: 'Direct User',
            },
          },
        },
      };

      ws._simulateMessage(JSON.stringify(feishuEvent));

      expect(receivedMessages).toHaveLength(1);
      expect(receivedMessages[0].channelType).toBe('user');
      expect(receivedMessages[0].channelId).toBe('user-abc');
    });

    it('should ignore non-text messages', async () => {
      await adapter.connect();
      const ws = MockWebSocket.instances[0];

      const receivedMessages: IMMessage[] = [];
      adapter.onMessage((msg) => receivedMessages.push(msg));

      const feishuEvent = {
        header: { event_type: 'im.message.receive_v1' },
        event: {
          message: {
            message_id: 'msg-125',
            message_type: 'image',
            content: '{}',
            chat_type: 'p2p',
            create_time: '1700000000000',
          },
          sender: { sender_id: { open_id: 'user-abc' } },
        },
      };

      ws._simulateMessage(JSON.stringify(feishuEvent));

      expect(receivedMessages).toHaveLength(0);
    });

    it('should ignore non-message events', async () => {
      await adapter.connect();
      const ws = MockWebSocket.instances[0];

      const receivedMessages: IMMessage[] = [];
      adapter.onMessage((msg) => receivedMessages.push(msg));

      const nonMessageEvent = {
        header: { event_type: 'app_mention' },
        event: {},
      };

      ws._simulateMessage(JSON.stringify(nonMessageEvent));

      expect(receivedMessages).toHaveLength(0);
    });
  });

  describe('healthCheck', () => {
    it('should return true when connected', async () => {
      await adapter.connect();
      expect(await adapter.healthCheck()).toBe(true);
    });

    it('should return false when disconnected', () => {
      expect(adapter.healthCheck()).resolves.toBe(false);
    });
  });
});
