// T18/M4 (audit round3): the IM protocol no longer references the concrete
// QueryEngine class. Consumers depend on the structural surface below; the
// real engine satisfies it by construction.

export type IMPlatform = 'feishu' | 'wecom' | 'dingtalk';

export interface IMMessage {
  id: string;
  platform: IMPlatform;
  direction: 'inbound' | 'outbound';
  channelType: 'user' | 'group';
  channelId: string;
  senderId: string;
  senderName?: string;
  content: IMContent;
  replyTo?: string;
  timestamp: number;
  raw?: unknown;
}

export type IMContent =
  | { type: 'text'; text: string }
  | { type: 'rich_text'; elements: IMRichTextElement[] }
  | { type: 'card'; templateId: string; data: Record<string, unknown> };

export interface IMRichTextElement {
  tag: 'text' | 'a' | 'at' | 'img';
  text?: string;
  href?: string;
  userId?: string;
  imageKey?: string;
}

export interface IMAdapter {
  readonly platform: IMPlatform;
  readonly name: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  sendMessage(message: IMMessage): Promise<void>;
  onMessage(handler: (message: IMMessage) => void): void;
  healthCheck(): Promise<boolean>;
}

export interface IMSession {
  sessionId: string;
  platform: IMPlatform;
  channelId: string;
  channelType: 'user' | 'group';
  createdAt: number;
  lastActivityAt: number;
  messageCount: number;
  status: 'active' | 'idle' | 'expired';
}

export interface IMBridgeConfig {
  enabled: boolean;
  adapters: Record<IMPlatform, IMAdapterConfig>;
  session: IMSessionConfig;
  server?: IMServerConfig;
}

export interface IMAdapterConfig {
  enabled: boolean;
  appId?: string;
  appSecret?: string;
  options?: Record<string, unknown>;
}

export interface IMSessionConfig {
  timeoutMinutes: number;
  maxSessions: number;
  maxQueueSize: number;
}

export interface IMServerConfig {
  port: number;
  host?: string;
  webhookPath?: string;
}

export interface IMNotificationTarget {
  platform: IMPlatform;
  channelId: string;
  channelType: 'user' | 'group';
}

/**
 * Structural surface of the query engine that the IM bridge consumes
 * (T18/M4 decoupling — no import of the QueryEngine concrete class).
 */
export interface IMQueryEngineLike {
  submitMessage(userMessage: string): AsyncGenerator<IMEngineEvent, void, unknown>;
  abort(reason?: string): void;
}

/** Structural event view: consumers narrow on `type` plus their own fields. */
export interface IMEngineEvent {
  type: string;
  [key: string]: unknown;
}

export type EngineFactory = () => Promise<IMQueryEngineLike>;
