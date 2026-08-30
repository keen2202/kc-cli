// MCP module public API

export { MCPClientManager } from './client-manager';
export { convertMCPTool } from './tool-bridge';
export { loadMCPConfig } from './config-loader';
export type { LoadedMCPConfig, MCPServerOrigin } from './config-loader';
export { MCPServerConfigSchema, MCPConfigSchema } from './schema';
export { evaluateTrust, trustServer, isTrusted } from './trust-store';
export type { TrustDecision, TrustRecord } from './trust-store';
export type {
  MCPServerConfig,
  MCPConfig,
  MCPTool,
  MCPToolResult,
  MCPInitializeResult,
  MCPConnectionStatus,
  TransportType,
} from './types';
