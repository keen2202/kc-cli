// LSP navigation provider - references, rename, workspace symbols

import type { LSPPosition, LSPLocation } from './types';
import type { DocumentManager } from './document-manager';
import type { LSPClientManager } from './client';

export interface WorkspaceEdit {
  changes?: Record<string, TextEdit[]>;
  documentChanges?: (TextDocumentEdit | CreateFile | RenameFile | DeleteFile)[];
}

export interface TextEdit {
  range: { start: LSPPosition; end: LSPPosition };
  newText: string;
}

export interface TextDocumentEdit {
  textDocument: { uri: string; version?: number };
  edits: TextEdit[];
}

export interface CreateFile {
  kind: 'create';
  uri: string;
}

export interface RenameFile {
  kind: 'rename';
  oldUri: string;
  newUri: string;
}

export interface DeleteFile {
  kind: 'delete';
  uri: string;
}

export interface SymbolInformation {
  name: string;
  kind: number;
  location: LSPLocation;
  containerName?: string;
}

export class NavigationProvider {
  /**
   * Find all references to a symbol at the given position.
   */
  async findReferences(
    clientManager: LSPClientManager,
    docManager: DocumentManager,
    filePath: string,
    position: LSPPosition,
    includeDeclaration = true,
  ): Promise<LSPLocation[]> {
    const doc = docManager.get(filePath);
    if (!doc) return [];

    // Ensure document is synced
    if (!docManager.isOpen(filePath)) {
      await docManager.open(filePath, doc.content, doc.languageId);
    }

    try {
      const result = await clientManager.request(filePath, 'textDocument/references', {
        textDocument: { uri: doc.uri },
        position,
        context: { includeDeclaration },
      });

      return Array.isArray(result) ? result as LSPLocation[] : [];
    } catch {
      return [];
    }
  }

  /**
   * Rename a symbol at the given position.
   * Returns a WorkspaceEdit that can be applied to the file system.
   */
  async rename(
    clientManager: LSPClientManager,
    docManager: DocumentManager,
    filePath: string,
    position: LSPPosition,
    newName: string,
  ): Promise<WorkspaceEdit | null> {
    const doc = docManager.get(filePath);
    if (!doc) return null;

    if (!docManager.isOpen(filePath)) {
      await docManager.open(filePath, doc.content, doc.languageId);
    }

    try {
      const result = await clientManager.request(filePath, 'textDocument/rename', {
        textDocument: { uri: doc.uri },
        position,
        newName,
      });

      return result as WorkspaceEdit | null;
    } catch {
      return null;
    }
  }

  /**
   * Search for symbols across the workspace.
   */
  async findWorkspaceSymbols(
    clientManager: LSPClientManager,
    query: string,
  ): Promise<SymbolInformation[]> {
    try {
      const result = await clientManager.request('', 'workspace/symbol', { query });
      return Array.isArray(result) ? result as SymbolInformation[] : [];
    } catch {
      return [];
    }
  }

  /**
   * Apply a workspace edit to the file system.
   */
  async applyWorkspaceEdit(edit: WorkspaceEdit): Promise<void> {
    const fs = await import('fs');

    // Handle document changes
    if (edit.documentChanges) {
      for (const change of edit.documentChanges) {
        if ('textDocument' in change) {
          // TextDocumentEdit
          const filePath = change.textDocument.uri.replace('file://', '');
          if (fs.existsSync(filePath)) {
            let content = fs.readFileSync(filePath, 'utf-8');
            // Apply edits in reverse order to maintain positions
            const sortedEdits = [...change.edits].sort((a, b) => {
              if (a.range.start.line !== b.range.start.line) {
                return b.range.start.line - a.range.start.line;
              }
              return b.range.start.character - a.range.start.character;
            });
            for (const textEdit of sortedEdits) {
              content = this.applyTextEdit(content, textEdit);
            }
            fs.writeFileSync(filePath, content, 'utf-8');
          }
        } else if ('kind' in change) {
          if (change.kind === 'create') {
            const filePath = change.uri.replace('file://', '');
            fs.writeFileSync(filePath, '', 'utf-8');
          } else if (change.kind === 'delete') {
            const filePath = change.uri.replace('file://', '');
            if (fs.existsSync(filePath)) {
              fs.unlinkSync(filePath);
            }
          }
        }
      }
    }

    // Handle changes map
    if (edit.changes) {
      for (const [uri, edits] of Object.entries(edit.changes)) {
        const filePath = uri.replace('file://', '');
        if (fs.existsSync(filePath)) {
          let content = fs.readFileSync(filePath, 'utf-8');
          const sortedEdits = [...edits].sort((a, b) => {
            if (a.range.start.line !== b.range.start.line) {
              return b.range.start.line - a.range.start.line;
            }
            return b.range.start.character - a.range.start.character;
          });
          for (const textEdit of sortedEdits) {
            content = this.applyTextEdit(content, textEdit);
          }
          fs.writeFileSync(filePath, content, 'utf-8');
        }
      }
    }
  }

  private applyTextEdit(content: string, edit: TextEdit): string {
    const lines = content.split('\n');
    const { start, end } = edit.range;

    const before = lines.slice(0, start.line);
    const after = lines.slice(end.line + 1);

    const lineBefore = lines[start.line]?.slice(0, start.character) || '';
    const lineAfter = lines[end.line]?.slice(end.character) || '';

    const newLines = [...before, lineBefore + edit.newText + lineAfter, ...after];
    return newLines.join('\n');
  }
}
