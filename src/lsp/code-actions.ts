// LSP code actions provider - quick fixes, organize imports

import type { LSPPosition, LSPRange } from './types';
import type { DocumentManager } from './document-manager';
import type { LSPClientManager } from './client';
import type { WorkspaceEdit } from './navigation';

export enum CodeActionKind {
  QuickFix = 'quickfix',
  Refactor = 'refactor',
  RefactorExtract = 'refactor.extract',
  RefactorInline = 'refactor.inline',
  SourceOrganizeImports = 'source.organizeImports',
  SourceFixAll = 'source.fixAll',
}

export interface CodeAction {
  title: string;
  kind?: CodeActionKind | string;
  diagnostics?: unknown[];
  edit?: WorkspaceEdit;
  command?: {
    title: string;
    command: string;
    arguments?: unknown[];
  };
  isPreferred?: boolean;
}

export class CodeActionProvider {
  /**
   * Get code actions at a range in a file.
   */
  async getCodeActions(
    clientManager: LSPClientManager,
    docManager: DocumentManager,
    filePath: string,
    range: LSPRange,
    context?: {
      diagnostics?: unknown[];
      only?: string[];
    },
  ): Promise<CodeAction[]> {
    const doc = docManager.get(filePath);
    if (!doc) return [];

    if (!docManager.isOpen(filePath)) {
      await docManager.open(filePath, doc.content, doc.languageId);
    }

    try {
      const result = await clientManager.request(filePath, 'textDocument/codeAction', {
        textDocument: { uri: doc.uri },
        range,
        context: {
          diagnostics: context?.diagnostics ?? [],
          ...(context?.only ? { only: context.only } : {}),
        },
      });

      return Array.isArray(result) ? result as CodeAction[] : [];
    } catch {
      return [];
    }
  }

  /**
   * Apply a code action. Handles both workspace edits and commands.
   */
  async applyCodeAction(
    action: CodeAction,
    navigationProvider?: { applyWorkspaceEdit: (edit: WorkspaceEdit) => Promise<void> },
  ): Promise<void> {
    if (action.edit && navigationProvider) {
      await navigationProvider.applyWorkspaceEdit(action.edit);
    }
    // Commands are not directly executable - they need to be sent back to the language server
    // This is a limitation of the current architecture
  }

  /**
   * Get quick fixes for diagnostics at a position.
   */
  async getQuickFixes(
    clientManager: LSPClientManager,
    docManager: DocumentManager,
    filePath: string,
    position: LSPPosition,
    diagnostics: unknown[],
  ): Promise<CodeAction[]> {
    return this.getCodeActions(clientManager, docManager, filePath, {
      start: position,
      end: position,
    }, {
      diagnostics,
      only: [CodeActionKind.QuickFix],
    });
  }

  /**
   * Organize imports in a file.
   */
  async organizeImports(
    clientManager: LSPClientManager,
    docManager: DocumentManager,
    filePath: string,
  ): Promise<CodeAction[]> {
    const doc = docManager.get(filePath);
    if (!doc) return [];

    const fullRange: LSPRange = {
      start: { line: 0, character: 0 },
      end: { line: Number.MAX_SAFE_INTEGER, character: 0 },
    };

    return this.getCodeActions(clientManager, docManager, filePath, fullRange, {
      only: [CodeActionKind.SourceOrganizeImports],
    });
  }

}
