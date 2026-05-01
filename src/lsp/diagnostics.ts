// LSP Diagnostic collection and caching

import type { LSPDiagnostic } from './types';
import { LSPClientManager, detectLanguage } from './client';

type SeverityFilter = 'all' | 'errors' | 'warnings';

export class DiagnosticCollector {
  private clientManager: LSPClientManager;
  private cache = new Map<string, LSPDiagnostic[]>();
  private fileVersions = new Map<string, number>();

  constructor(clientManager?: LSPClientManager) {
    this.clientManager = clientManager || new LSPClientManager();
  }

  /**
   * Get diagnostics for a specific file, using cache if available
   */
  async getDiagnosticsForFile(filePath: string, content?: string): Promise<LSPDiagnostic[]> {
    const cached = this.cache.get(filePath);
    if (cached && !content) return cached;

    if (content) {
      const diagnostics = await this.clientManager.getDiagnostics(filePath, content);
      this.cache.set(filePath, diagnostics);
      this.fileVersions.set(filePath, (this.fileVersions.get(filePath) || 0) + 1);
      return diagnostics;
    }

    return cached || [];
  }

  /**
   * Get diagnostics for all open files, grouped by file path
   */
  getDiagnosticsForWorkspace(filter: SeverityFilter = 'all'): Map<string, LSPDiagnostic[]> {
    const result = new Map<string, LSPDiagnostic[]>();

    for (const [filePath, diagnostics] of this.cache) {
      const filtered = this.filterBySeverity(diagnostics, filter);
      if (filtered.length > 0) {
        result.set(filePath, filtered);
      }
    }

    return result;
  }

  /**
   * Invalidate cache for a specific file (called on file change)
   */
  invalidateFile(filePath: string): void {
    this.cache.delete(filePath);
    this.fileVersions.delete(filePath);
  }

  /**
   * Invalidate all cached diagnostics
   */
  invalidateAll(): void {
    this.cache.clear();
    this.fileVersions.clear();
  }

  /**
   * Get the cache version for a file (incremented on each update)
   */
  getFileVersion(filePath: string): number {
    return this.fileVersions.get(filePath) || 0;
  }

  /**
   * Get total diagnostic count across all files
   */
  getTotalCount(filter: SeverityFilter = 'all'): number {
    let count = 0;
    for (const diagnostics of this.cache.values()) {
      count += this.filterBySeverity(diagnostics, filter).length;
    }
    return count;
  }

  private filterBySeverity(diagnostics: LSPDiagnostic[], filter: SeverityFilter): LSPDiagnostic[] {
    if (filter === 'all') return diagnostics;

    return diagnostics.filter(d => {
      if (filter === 'errors') return d.severity === 1;
      if (filter === 'warnings') return d.severity === 1 || d.severity === 2;
      return true;
    });
  }
}
