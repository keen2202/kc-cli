// ACP Protocol types (JSON-RPC 2.0 based)

export interface ACPRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface ACPResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface ACPNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

export interface ACPSessionInfo {
  sessionId: string;
  model: string;
  provider: string;
  status: 'idle' | 'running' | 'completed' | 'error';
  createdAt: number;
}
