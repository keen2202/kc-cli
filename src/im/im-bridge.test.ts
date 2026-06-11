import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IMBridge } from './im-bridge';
import type { IMAdapter, IMBridgeConfig, IMMessage, EngineFactory } from './protocol';
import type { QueryEngine } from '../query/QueryEngine';

// Mock QueryEngine
const createMockEngine = () => ({
  submitMessage: vi.fn(async function* () {
    yield { type: 'agent:text_delta', text: 'Hello', timestamp: Date.now() };
    yield { type: 'agent:text_delta', text: ' World', timestamp: Date.now() };
    yield { type: 'agent:complete', timestamp: Date.now() };
  }),
  abort: vi.fn(),
});

// Mock adapter
const createMockAdapter = (platform: 'feishu' | 'wecom' | 'dingtalk' = 'feishu'): IMAdapter => {
  let messageHandler: ((message: IMMessage) => void) | null = null;
  return {
    platform,
    name: `mock-${platform}`,
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    isConnected: vi.fn(() => true),
    sendMessage: vi.fn(async () => {}),
    onMessage: vi.fn((handler) => { messageHandler = handler; }),
    healthCheck: vi.fn(async () => true),
    _triggerMessage: (msg: IMMessage) => messageHandler?.(msg),
  } as any;
};

const defaultConfig: IMBridgeConfig = {
  enabled: true,
  adapters: {
    feishu: { enabled: true, appId: 'test', appSecret: 'test' },
    wecom: { enabled: false },
    dingtalk: { enabled: false },
  },
  session: {
    timeoutMinutes: 30,
    maxSessions: 100,
    maxQueueSize: 10,
  },
};

describe('IMBridge', () => {
  let bridge: IMBridge;
  let mockEngine: ReturnType<typeof createMockEngine>;
  let engineFactory: EngineFactory;

  beforeEach(() => {
    mockEngine = createMockEngine();
    engineFactory = vi.fn(async () => mockEngine as unknown as QueryEngine);
    bridge = new IMBridge(defaultConfig, engineFactory);
  });

  afterEach(async () => {
    await bridge.shutdownAll();
  });

  describe('registerAdapter', () => {
    it('should register an adapter and set up message handler', () => {
      const adapter = createMockAdapter();
      bridge.registerAdapter(adapter);

      expect(adapter.onMessage).toHaveBeenCalled();
    });
  });

  describe('startAll', () => {
    it('should connect all registered adapters', async () => {
      const adapter = createMockAdapter();
      bridge.registerAdapter(adapter);

      await bridge.startAll();

      expect(adapter.connect).toHaveBeenCalled();
    });

    it('should handle connection failures gracefully', async () => {
      const adapter = createMockAdapter();
      (adapter.connect as any).mockRejectedValue(new Error('Connection failed'));
      bridge.registerAdapter(adapter);

      // Should not throw
      await bridge.startAll();
    });
  });

  describe('shutdownAll', () => {
    it('should disconnect all adapters', async () => {
      const adapter = createMockAdapter();
      bridge.registerAdapter(adapter);
      await bridge.startAll();

      await bridge.shutdownAll();

      expect(adapter.disconnect).toHaveBeenCalled();
    });
  });

  describe('message handling', () => {
    it('should process inbound text messages', async () => {
      const adapter = createMockAdapter();
      bridge.registerAdapter(adapter);
      await bridge.startAll();

      const inboundMessage: IMMessage = {
        id: 'msg-1',
        platform: 'feishu',
        direction: 'inbound',
        channelType: 'user',
        channelId: 'user-123',
        senderId: 'sender-1',
        content: { type: 'text', text: 'Hello' },
        timestamp: Date.now(),
      };

      // Trigger the message
      (adapter as any)._triggerMessage(inboundMessage);

      // Wait for async processing
      await new Promise(resolve => setTimeout(resolve, 10));

      // Should have called submitMessage
      expect(mockEngine.submitMessage).toHaveBeenCalledWith('Hello');

      // Should have sent reply
      expect(adapter.sendMessage).toHaveBeenCalled();
      const sentMessage = (adapter.sendMessage as any).mock.calls[0][0] as IMMessage;
      expect(sentMessage.content).toEqual({ type: 'text', text: 'Hello World' });
      expect(sentMessage.direction).toBe('outbound');
    });

    it('should queue messages when engine is busy', async () => {
      const adapter = createMockAdapter();
      bridge.registerAdapter(adapter);
      await bridge.startAll();

      // Make the engine slow
      mockEngine.submitMessage = vi.fn(async function* () {
        yield { type: 'agent:text_delta', text: 'Response', timestamp: Date.now() };
        // Don't complete immediately
        await new Promise(resolve => setTimeout(resolve, 100));
        yield { type: 'agent:complete', timestamp: Date.now() };
      });

      const msg1: IMMessage = {
        id: 'msg-1', platform: 'feishu', direction: 'inbound',
        channelType: 'user', channelId: 'user-1', senderId: 's1',
        content: { type: 'text', text: 'First' }, timestamp: Date.now(),
      };
      const msg2: IMMessage = {
        id: 'msg-2', platform: 'feishu', direction: 'inbound',
        channelType: 'user', channelId: 'user-1', senderId: 's1',
        content: { type: 'text', text: 'Second' }, timestamp: Date.now(),
      };

      (adapter as any)._triggerMessage(msg1);
      (adapter as any)._triggerMessage(msg2);

      await new Promise(resolve => setTimeout(resolve, 200));

      // Both messages should have been processed
      expect(mockEngine.submitMessage).toHaveBeenCalledTimes(2);
    });
  });

  describe('notify', () => {
    it('should send notification to connected adapter', async () => {
      const adapter = createMockAdapter();
      bridge.registerAdapter(adapter);
      await bridge.startAll();

      await bridge.notify(
        { platform: 'feishu', channelId: 'chat-123', channelType: 'group' },
        { type: 'text', text: 'Notification' }
      );

      expect(adapter.sendMessage).toHaveBeenCalled();
      const sent = (adapter.sendMessage as any).mock.calls[0][0] as IMMessage;
      expect(sent.content).toEqual({ type: 'text', text: 'Notification' });
      expect(sent.channelId).toBe('chat-123');
    });
  });

  describe('session management', () => {
    it('should track active sessions', async () => {
      const adapter = createMockAdapter();
      bridge.registerAdapter(adapter);
      await bridge.startAll();

      expect(bridge.getActiveSessionCount()).toBe(0);

      const msg: IMMessage = {
        id: 'msg-1', platform: 'feishu', direction: 'inbound',
        channelType: 'user', channelId: 'user-1', senderId: 's1',
        content: { type: 'text', text: 'Hello' }, timestamp: Date.now(),
      };

      (adapter as any)._triggerMessage(msg);
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(bridge.getActiveSessionCount()).toBe(1);
    });
  });

  describe('getAdapterStatus', () => {
    it('should return adapter connection status', async () => {
      const adapter = createMockAdapter();
      bridge.registerAdapter(adapter);
      await bridge.startAll();

      const status = bridge.getAdapterStatus();
      expect(status).toHaveLength(1);
      expect(status[0].platform).toBe('feishu');
      expect(status[0].connected).toBe(true);
    });
  });
});
