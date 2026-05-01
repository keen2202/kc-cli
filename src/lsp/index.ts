// LSP Module - Language Server Protocol client integration

export { LSPClientManager, detectLanguage } from './client';
export { DiagnosticCollector } from './diagnostics';
export { tool as LSPTool } from './tool';
export type { LSPDiagnostic, LSPHover, LSPLocation, LanguageId } from './types';
