import type { QueryEngine } from '../query/QueryEngine';

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

export type EngineFactory = () => Promise<QueryEngine>;
