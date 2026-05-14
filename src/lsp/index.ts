// LSP Module - Language Server Protocol client integration

export { LSPClientManager, detectLanguage } from './client';
export { DiagnosticCollector } from './diagnostics';
export { CompletionProvider, CompletionItemKind } from './completion';
export { NavigationProvider } from './navigation';
export { CodeActionProvider, CodeActionKind } from './code-actions';
export { DocumentManager } from './document-manager';
export { tool as LSPTool } from './tool';
export type { LSPDiagnostic, LSPHover, LSPLocation, LanguageId } from './types';
export type { LSPCompletionItem, CompletionResult } from './completion';
export type { CodeAction } from './code-actions';
