import { AutoReconnectService } from '../../services/autoReconnect';
import { CircuitBreaker } from '../../services/circuitBreaker';
import { logger } from '../../services/logger';
import { createRequire } from 'node:module';
import type {
  IMAdapter,
  IMAdapterConfig,
  IMMessage,
  IMContent,
  IMPlatform,
} from '../protocol';

// ESM-compatible require for lazy loading the 'ws' package (CommonJS module)
const require = createRequire(import.meta.url);

const FEISHU_WS_URL = 'wss://open.feishu.cn/open-apis/ws/v1/events';
const FEISHU_TOKEN_URL = 'https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal';
const FEISHU_MESSAGE_URL = 'https://open.feishu.cn/open-apis/im/v1/messages';
const HEARTBEAT_INTERVAL_MS = 30_000;

interface FeishuTokenResponse {
  app_access_token: string;
  expire: number;
  code: number;
  msg: string;
}

interface FeishuWebSocketFrame {
  header?: {
    event_type?: string;
    token?: string;
    [key: string]: unknown;
  };
  event?: unknown;
  type?: string; // for ack frames
}

interface FeishuMessageEvent {
  message?: {
    message_id?: string;
    message_type?: string;
    content?: string;
    chat_id?: string;
    chat_type?: string;
    create_time?: string;
  };
  sender?: {
    sender_id?: {
      open_id?: string;
      union_id?: string;
      user_id?: string;
      name?: string;
    };
    sender_type?: string;
  };
}

export class FeishuAdapter implements IMAdapter {
  readonly platform = 'feishu' as IMPlatform;
  readonly name = 'feishu';

  private ws: WebSocket | null = null;
  private messageHandler: ((message: IMMessage) => void) | null = null;
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;
  private reconnectService: AutoReconnectService;
  private circuitBreaker: CircuitBreaker;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private config: IMAdapterConfig;
  private _connected = false;

  constructor(config: IMAdapterConfig) {
    this.config = config;
    this.reconnectService = new AutoReconnectService({
      maxAttempts: 5,
      baseDelayMs: 2000,
      maxDelayMs: 60_000,
      backoffMultiplier: 2,
    });
    this.circuitBreaker = new CircuitBreaker('feishu-ws', {
      failureThreshold: 5,
      resetTimeoutMs: 30_000,
    });

    this.reconnectService.registerService('feishu-ws', async () => {
      try {
        await this.connectWebSocket();
        return this._connected;
      } catch {
        return false;
      }
    });
  }

  async connect(): Promise<void> {
    await this.obtainAccessToken();
    await this.connectWebSocket();
    this.reconnectService.markConnected('feishu-ws');
  }

  async disconnect(): Promise<void> {
    this.stopHeartbeat();
    this.reconnectService.cancelReconnect('feishu-ws');

    if (this.ws) {
      try {
        this.ws.close(1000, 'shutdown');
      } catch {
        // Ignore close errors
      }
      this.ws = null;
    }
    this._connected = false;
  }

  isConnected(): boolean {
    return this._connected;
  }

  async sendMessage(message: IMMessage): Promise<void> {
    if (!this.circuitBreaker.canExecute()) {
      throw new Error('Feishu circuit breaker is open');
    }

    const token = await this.obtainAccessToken();
    const receiveIdType = message.channelType === 'user' ? 'open_id' : 'chat_id';

    let msgType: string;
    let contentStr: string;

    if (message.content.type === 'text') {
      msgType = 'text';
      contentStr = JSON.stringify({ text: message.content.text });
    } else {
      // Future: rich text, cards
      msgType = 'text';
      contentStr = JSON.stringify({ text: JSON.stringify(message.content) });
    }

    const url = new URL(FEISHU_MESSAGE_URL);
    url.searchParams.set('receive_id_type', receiveIdType);

    const resp = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        receive_id: message.channelId,
        msg_type: msgType,
        content: contentStr,
      }),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => 'unknown');
      this.circuitBreaker.recordFailure();
      throw new Error(`Feishu send failed: ${resp.status} ${body}`);
    }

    this.circuitBreaker.recordSuccess();
  }

  onMessage(handler: (message: IMMessage) => void): void {
    this.messageHandler = handler;
  }

  async healthCheck(): Promise<boolean> {
    return this._connected && this.circuitBreaker.getState() !== 'open';
  }

  private async obtainAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt) {
      return this.accessToken;
    }

    const resp = await fetch(FEISHU_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app_id: this.config.appId,
        app_secret: this.config.appSecret,
      }),
    });

    if (!resp.ok) {
      throw new Error(`Feishu token request failed: ${resp.status}`);
    }

    const data = (await resp.json()) as FeishuTokenResponse;
    if (data.code !== 0) {
      throw new Error(`Feishu token error: ${data.msg} (code: ${data.code})`);
    }

    this.accessToken = data.app_access_token;
    // Refresh at 90% of TTL (expire is in seconds)
    this.tokenExpiresAt = Date.now() + (data.expire - 720) * 1000;
    return this.accessToken;
  }

  private async connectWebSocket(): Promise<void> {
    const token = await this.obtainAccessToken();

    return new Promise((resolve, reject) => {
      try {
        // Dynamic import for Node.js WebSocket support
        // In browser environments, native WebSocket is available
        const WS = this.getWebSocketConstructor();
        const isWsPackage = typeof WebSocket === 'undefined';
        let ws: any;

        if (isWsPackage) {
          // Node.js 'ws' package supports custom headers (SEC-07)
          // Pass auth via headers to avoid leaking app_secret in URLs/logs
          ws = new WS(FEISHU_WS_URL, {
            headers: {
              'X-App-Id': this.config.appId,
              'X-App-Secret': this.config.appSecret,
            },
          });
        } else {
          // Browser native WebSocket must use query params for auth
          const wsUrl = `${FEISHU_WS_URL}?app_id=${this.config.appId}&app_secret=${this.config.appSecret}`;
          ws = new WS(wsUrl);
        }

        const timeout = setTimeout(() => {
          ws.close();
          reject(new Error('WebSocket connection timeout'));
        }, 10_000);

        ws.onopen = () => {
          clearTimeout(timeout);
          this.ws = ws as any;
          this._connected = true;
          this.startHeartbeat();
          logger.services.info('[FeishuAdapter] WebSocket connected');
          resolve();
        };

        ws.onmessage = (event: any) => {
          this.handleWebSocketMessage(event.data);
        };

        ws.onclose = (event: any) => {
          this._connected = false;
          this.stopHeartbeat();
          logger.services.warn(`[FeishuAdapter] WebSocket closed: ${event.code} ${event.reason}`);
          this.reconnectService.scheduleReconnect('feishu-ws');
        };

        ws.onerror = (err: any) => {
          // Redact sensitive URL params from error messages to prevent secret leakage
          const errMsg = err instanceof Error ? err.message : String(err);
          const sanitized = errMsg.replace(/app_secret=[^&\s]+/gi, 'app_secret=***');
          logger.services.error(`[FeishuAdapter] WebSocket error: ${sanitized}`);
          if (!this._connected) {
            clearTimeout(timeout);
            reject(err);
          }
        };
      } catch (err) {
        reject(err);
      }
    });
  }

  private getWebSocketConstructor(): any {
    // In Node.js, use the 'ws' package
    // In browser, use native WebSocket
    if (typeof WebSocket !== 'undefined') {
      return WebSocket;
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return require('ws');
    } catch {
      throw new Error('No WebSocket implementation available. Install "ws" package for Node.js.');
    }
  }

  private handleWebSocketMessage(data: unknown): void {
    let frame: FeishuWebSocketFrame;
    try {
      const raw = typeof data === 'string' ? data : String(data);
      frame = JSON.parse(raw);
    } catch {
      logger.services.warn('[FeishuAdapter] Failed to parse WebSocket frame');
      return;
    }

    // Handle ping/pong frames
    if (frame.type === 'pong') return;

    // Handle event frames
    if (frame.header?.event_type === 'im.message.receive_v1') {
      const parsed = this.parseEvent(frame);
      if (parsed && this.messageHandler) {
        this.messageHandler(parsed);
      }
    }
  }

  private parseEvent(frame: FeishuWebSocketFrame): IMMessage | null {
    const event = frame.event as FeishuMessageEvent;
    if (!event?.message) return null;

    const msgType = event.message.message_type;
    if (msgType !== 'text') return null;

    let content: IMContent;
    try {
      const parsed = JSON.parse(event.message.content || '{}');
      content = { type: 'text', text: parsed.text || '' };
    } catch {
      return null;
    }

    if (!content.text.trim()) return null;

    const chatType = event.message.chat_type;
    const channelId = chatType === 'p2p'
      ? event.sender?.sender_id?.open_id || ''
      : event.message.chat_id || '';

    if (!channelId) return null;

    return {
      id: event.message.message_id || `msg-${Date.now()}`,
      platform: 'feishu',
      direction: 'inbound',
      channelType: chatType === 'p2p' ? 'user' : 'group',
      channelId,
      senderId: event.sender?.sender_id?.open_id || '',
      senderName: event.sender?.sender_id?.name,
      content,
      timestamp: parseInt(event.message.create_time || String(Date.now()), 10),
      raw: frame,
    };
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this._connected) {
        try {
          (this.ws as any).send?.(JSON.stringify({ type: 'ping' }));
        } catch {
          // Will be handled by onclose/onerror
        }
      }
    }, HEARTBEAT_INTERVAL_MS);

    if (this.heartbeatTimer.unref) {
      this.heartbeatTimer.unref();
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
