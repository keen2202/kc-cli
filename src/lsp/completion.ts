// LSP completion provider
// Provides code completion via textDocument/completion requests.

import type { LSPPosition, LSPRange } from './types';
import type { DocumentManager } from './document-manager';
import type { LSPClientManager } from './client';

export enum CompletionItemKind {
  Text = 1,
  Method = 2,
  Function = 3,
  Constructor = 4,
  Field = 5,
  Variable = 6,
  Class = 7,
  Interface = 8,
  Module = 9,
  Property = 10,
  Unit = 11,
  Value = 12,
  Enum = 13,
  Keyword = 14,
  Snippet = 15,
  Color = 16,
  File = 17,
  Reference = 18,
  Folder = 19,
  EnumMember = 20,
  Constant = 21,
  Struct = 22,
  Event = 23,
  Operator = 24,
  TypeParameter = 25,
}

export interface LSPCompletionItem {
  label: string;
  kind: CompletionItemKind;
  detail?: string;
  documentation?: string;
  insertText?: string;
  sortText?: string;
  filterText?: string;
  additionalTextEdits?: Array<{
    range: LSPRange;
    newText: string;
  }>;
}

export interface CompletionResult {
  items: LSPCompletionItem[];
  isIncomplete: boolean;
}

export class CompletionProvider {
  private maxItems = 20;

  /**
   * Get completions at a specific position in a file.
   */
  async getCompletions(
    clientManager: LSPClientManager,
    docManager: DocumentManager,
    filePath: string,
    position: LSPPosition,
  ): Promise<CompletionResult> {
    const doc = docManager.get(filePath);
    if (!doc) {
      return { items: [], isIncomplete: false };
    }

    // Ensure document is synced
    if (!docManager.isOpen(filePath)) {
      await docManager.open(filePath, doc.content, doc.languageId);
    }

    try {
      const result = await clientManager.request(filePath, 'textDocument/completion', {
        textDocument: { uri: doc.uri },
        position,
        context: { triggerKind: 1 }, // CompletionTriggerKind.Invoked
      });

      if (!result) {
        return { items: [], isIncomplete: false };
      }

      // Handle both CompletionList and CompletionItem[] formats
      const resultAny = result as any;
      const items = Array.isArray(result) ? result : resultAny.items ?? [];
      const isIncomplete = Array.isArray(result) ? false : resultAny.isIncomplete ?? false;

      return {
        items: this.sortAndFilter(items),
        isIncomplete,
      };
    } catch {
      return { items: [], isIncomplete: false };
    }
  }

  /**
   * Resolve additional details for a completion item.
   */
  async resolveCompletionItem(
    clientManager: LSPClientManager,
    item: LSPCompletionItem,
    filePath?: string,
  ): Promise<LSPCompletionItem> {
    try {
      const resolved = await clientManager.request(filePath ?? '', 'completionItem/resolve', {
        label: item.label,
        kind: item.kind,
      });

      if (resolved) {
        const resolvedAny = resolved as any;
        return {
          ...item,
          documentation: resolvedAny.documentation ?? item.documentation,
          detail: resolvedAny.detail ?? item.detail,
        };
      }
    } catch {
      // Resolution failed, return original
    }

    return item;
  }

  /**
   * Set the maximum number of completion items to return.
   */
  setMaxItems(max: number): void {
    this.maxItems = max;
  }

  /**
   * Sort by sortText and filter out snippets (agents don't need them).
   */
  private sortAndFilter(items: any[]): LSPCompletionItem[] {
    return items
      .filter((item: any) => {
        // Filter out snippet type (agent doesn't need them)
        if (item.kind === CompletionItemKind.Snippet) return false;
        // Filter out items without a label
        if (!item.label) return false;
        return true;
      })
      .sort((a: any, b: any) => {
        const sortA = a.sortText ?? a.label;
        const sortB = b.sortText ?? b.label;
        return sortA.localeCompare(sortB);
      })
      .slice(0, this.maxItems)
      .map((item: any) => ({
        label: item.label,
        kind: item.kind ?? CompletionItemKind.Text,
        detail: item.detail,
        documentation: typeof item.documentation === 'object'
          ? item.documentation.value
          : item.documentation,
        insertText: item.insertText ?? item.label,
        sortText: item.sortText,
        filterText: item.filterText,
      }));
  }
}
