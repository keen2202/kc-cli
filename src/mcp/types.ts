// MCP (Model Context Protocol) type definitions
// Aligned with @modelcontextprotocol/sdk spec 2024-11-05

export type TransportType = 'stdio' | 'http';

export interface MCPServerConfig {
  type: TransportType;
  command?: string;        // For stdio
  args?: string[];         // For stdio
  url?: string;            // For http
  env?: Record<string, string>;
  headers?: Record<string, string>;  // For http
  enabled?: boolean;
  oauth?: {               // OAuth 2.0 support (provided by SDK)
    clientId?: string;
    clientSecret?: string;
    tokenUrl?: string;
    scopes?: string[];
  };
}

export interface MCPConfig {
  mcpServers: Record<string, MCPServerConfig>;
}

export interface MCPTool {
  name: string;
  description?: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

export interface MCPResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface MCPPrompt {
  name: string;
  description?: string;
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
}

export interface MCPToolResult {
  content: Array<{
    type: 'text';
    text: string;
  } | {
    type: 'image';
    data: string;
    mimeType: string;
  } | {
    type: 'resource';
    resource: { uri: string; text?: string; mimeType?: string };
  }>;
  isError?: boolean;
}

export interface MCPInitializeResult {
  protocolVersion: string;
  capabilities: {
    tools?: { listChanged?: boolean };
    resources?: { subscribe?: boolean };
    prompts?: {};
  };
  serverInfo: {
    name: string;
    version: string;
  };
}

export interface MCPListToolsResult {
  tools: MCPTool[];
}

export interface MCPListResourcesResult {
  resources: MCPResource[];
}

export interface MCPListPromptsResult {
  prompts: MCPPrompt[];
}

export interface JSONRPCRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface JSONRPCResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface JSONRPCNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

// SDK error codes
export enum MCPErrorCode {
  ParseError = -32700,
  InvalidRequest = -32600,
  MethodNotFound = -32601,
  InvalidParams = -32602,
  InternalError = -32603,
  ServerNotInitialized = -32002,
}

export type MCPConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';
