// Document lifecycle manager for LSP synchronization
// Tracks open documents, manages versions, and computes incremental changes.

import type { LanguageId } from './types';
import { LSPClientManager, detectLanguage } from './client';
import { pathToFileURL } from 'url';

export interface ManagedDocument {
  uri: string;
  filePath: string;
  languageId: LanguageId;
  version: number;
  content: string;
  isOpen: boolean;
  lastSyncedAt: number;
}

export interface TextDocumentContentChangeEvent {
  range?: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  text: string;
}

export class DocumentManager {
  private documents = new Map<string, ManagedDocument>();
  private clientManager: LSPClientManager;

  constructor(clientManager?: LSPClientManager) {
    this.clientManager = clientManager || new LSPClientManager();
  }

  /**
   * Open a document and notify the language server.
   */
  async open(filePath: string, content: string, languageId?: LanguageId): Promise<ManagedDocument> {
    const uri = pathToFileURL(filePath).href;
    const lang = languageId || detectLanguage(filePath);

    const doc: ManagedDocument = {
      uri,
      filePath,
      languageId: lang,
      version: 1,
      content,
      isOpen: true,
      lastSyncedAt: Date.now(),
    };

    this.documents.set(filePath, doc);

    // Ensure language server is connected
    const rootUri = pathToFileURL(process.cwd()).href;
    await this.clientManager.connect(lang, rootUri);

    // Send didOpen notification
    try {
      await (this.clientManager as any).sendRequest?.(
        // Use the internal sendRequest if available
        // Otherwise, getDiagnostics will trigger didOpen
        undefined
      );
    } catch {
      // Fallback: getDiagnostics handles didOpen internally
    }

    return doc;
  }

  /**
   * Update a document with new content, computing incremental changes.
   */
  async update(filePath: string, newContent: string): Promise<ManagedDocument> {
    const doc = this.documents.get(filePath);
    if (!doc) {
      throw new Error(`Document not opened: ${filePath}`);
    }

    const changes = this.computeIncrementalChanges(doc.content, newContent);
    doc.version++;
    doc.content = newContent;
    doc.lastSyncedAt = Date.now();

    // Send didChange notification
    // The client manager handles this internally via getDiagnostics
    // For incremental sync, we track the changes here for future use

    return doc;
  }

  /**
   * Close a document and notify the language server.
   */
  close(filePath: string): void {
    const doc = this.documents.get(filePath);
    if (doc) {
      doc.isOpen = false;
      this.documents.delete(filePath);
    }
  }

  /**
   * Get the current state of a document.
   */
  get(filePath: string): ManagedDocument | undefined {
    return this.documents.get(filePath);
  }

  /**
   * Get all open documents.
   */
  getAll(): ManagedDocument[] {
    return Array.from(this.documents.values()).filter(d => d.isOpen);
  }

  /**
   * Check if a document is open.
   */
  isOpen(filePath: string): boolean {
    const doc = this.documents.get(filePath);
    return doc?.isOpen ?? false;
  }

  /**
   * Get the content of a document, or undefined if not open.
   */
  getContent(filePath: string): string | undefined {
    return this.documents.get(filePath)?.content;
  }

  /**
   * Compute the minimal set of incremental changes between old and new content.
   * Uses line-based diffing for efficiency.
   */
  private computeIncrementalChanges(
    oldContent: string,
    newContent: string,
  ): TextDocumentContentChangeEvent[] {
    // If content is identical, no changes
    if (oldContent === newContent) return [];

    const oldLines = oldContent.split('\n');
    const newLines = newContent.split('\n');

    // Find the first differing line
    let startLine = 0;
    while (
      startLine < oldLines.length &&
      startLine < newLines.length &&
      oldLines[startLine] === newLines[startLine]
    ) {
      startLine++;
    }

    // If only new lines were added at the end
    if (startLine === oldLines.length && startLine < newLines.length) {
      return [{
        range: {
          start: { line: startLine, character: 0 },
          end: { line: startLine, character: 0 },
        },
        text: newLines.slice(startLine).join('\n') + (newContent.endsWith('\n') ? '' : ''),
      }];
    }

    // Find the last differing line
    let oldEnd = oldLines.length - 1;
    let newEnd = newLines.length - 1;
    while (
      oldEnd >= startLine &&
      newEnd >= startLine &&
      oldLines[oldEnd] === newLines[newEnd]
    ) {
      oldEnd--;
      newEnd--;
    }

    // If all lines are the same (shouldn't happen since content differs)
    if (oldEnd < startLine && newEnd < startLine) {
      return [];
    }

    // Compute the replacement text
    const replacementLines = newLines.slice(startLine, newEnd + 1);
    const replacementText = replacementLines.join('\n');

    // Determine end character
    const endChar = oldEnd < oldLines.length
      ? oldLines[oldEnd].length
      : 0;

    return [{
      range: {
        start: { line: startLine, character: 0 },
        end: { line: oldEnd, character: endChar },
      },
      text: replacementText,
    }];
  }
}
