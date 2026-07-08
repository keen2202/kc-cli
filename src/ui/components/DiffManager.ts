import chalk from 'chalk';
import { renderMultiFileDiff, type FileDiff } from '../diff-viewer';
import type { ChatMessage } from './ChatView';
import type { Theme } from '../theme';

const DIFF_TOOLS_SET = new Set(['FileWrite', 'FileEdit']);

export class DiffManager {
  private pendingDiffs: FileDiff[] = [];
  private activeDiffIndex: number = 0;

  private diffWorkerReady: boolean = false;
  private diffWorker: import('worker_threads').Worker | null = null;
  private diffCallbacks: Map<string, (result: string) => void> = new Map();
  private diffCounter: number = 0;

  initWorker(): void {
    try {
      const { Worker } = require('worker_threads');
      const workerCode = `
        const { parentPort } = require('worker_threads');
        parentPort.on('message', (data) => {
          try {
            const { id, oldContent, newContent } = data;
            const result = computeDiff(oldContent, newContent);
            parentPort.postMessage({ id, result });
          } catch (err) {
            parentPort.postMessage({ id: data.id, error: err.message });
          }
        });

        function computeDiff(oldContent, newContent) {
          const oldLines = (oldContent || '').split('\\n');
          const newLines = newContent.split('\\n');
          const maxLen = Math.max(oldLines.length, newLines.length);
          const parts = [];
          for (let i = 0; i < maxLen; i++) {
            const oldLine = oldLines[i];
            const newLine = newLines[i];
            if (oldLine === undefined) {
              parts.push({ type: 'add', line: newLine, lineNum: i + 1 });
            } else if (newLine === undefined) {
              parts.push({ type: 'del', line: oldLine, lineNum: i + 1 });
            } else if (oldLine !== newLine) {
              parts.push({ type: 'del', line: oldLine, lineNum: i + 1 });
              parts.push({ type: 'add', line: newLine, lineNum: i + 1 });
            } else {
              parts.push({ type: 'same', line: oldLine, lineNum: i + 1 });
            }
          }
          return parts;
        }
      `;

      this.diffWorker = new Worker(workerCode, { eval: true });
      this.diffWorker!.on('message', (msg: { id: string; result?: any; error?: string }) => {
        const cb = this.diffCallbacks.get(msg.id);
        if (cb) {
          this.diffCallbacks.delete(msg.id);
          if (msg.error) {
            cb('');
          } else {
            cb(msg.result);
          }
        }
      });
      this.diffWorker!.on('error', () => {
        this.diffWorkerReady = false;
        this.diffWorker = null;
      });
      this.diffWorkerReady = true;
    } catch (_err) {
      console.error("Suppressed error:", _err);
      this.diffWorkerReady = false;
    }
  }

  terminateWorker(): void {
    if (this.diffWorker) {
      this.diffWorker.terminate().catch(err => { console.error('[DiffManager] Failed to terminate worker', err); });
      this.diffWorker = null;
    }
  }

  captureDiff(toolName: string, metadata: any): void {
    if (!metadata) return;
    if (!DIFF_TOOLS_SET.has(toolName)) return;

    const oldContent = metadata.oldContent ?? undefined;
    const newContent = metadata.newContent ?? undefined;
    const filePath = metadata.path || metadata.file_path;

    if (!filePath || newContent === undefined) return;

    const existingIdx = this.pendingDiffs.findIndex(
      d => d.filePath === filePath && !d.accepted && !d.rejected
    );

    if (existingIdx >= 0) {
      this.pendingDiffs[existingIdx] = {
        filePath,
        oldContent: oldContent ?? null,
        newContent,
        accepted: false,
        rejected: false,
      };
    } else {
      this.pendingDiffs.push({
        filePath,
        oldContent: oldContent ?? null,
        newContent,
        accepted: false,
        rejected: false,
      });
    }
  }

  getPendingDiffs(): FileDiff[] {
    return this.pendingDiffs;
  }

  getActiveDiffIndex(): number {
    return this.activeDiffIndex;
  }

  setActiveDiffIndex(index: number): void {
    if (index >= 0 && index < this.pendingDiffs.length) {
      this.activeDiffIndex = index;
    }
  }

  unprocessedCount(): number {
    return this.pendingDiffs.filter(d => !d.accepted && !d.rejected).length;
  }

  acceptCurrent(): { filePath: string } | null {
    return this.processCurrent(true);
  }

  rejectCurrent(): { filePath: string } | null {
    return this.processCurrent(false);
  }

  private processCurrent(accept: boolean): { filePath: string } | null {
    if (this.pendingDiffs.length === 0) return null;
    const diff = this.pendingDiffs[this.activeDiffIndex];
    if (!diff) return null;

    if (accept) {
      diff.accepted = true;
    } else {
      diff.rejected = true;
    }
    this.advanceIndex();
    return { filePath: diff.filePath };
  }

  showDiffPreview(
    messages: ChatMessage[],
    sidebarWidth: number,
    theme: Theme,
  ): void {
    const unprocessed = this.pendingDiffs.filter(d => !d.accepted && !d.rejected);
    if (unprocessed.length === 0) return;

    const maxWidth = Math.min((process.stdout.columns || 80) - sidebarWidth - 6, 100);
    const diffPreview = renderMultiFileDiff(unprocessed, this.activeDiffIndex, { maxWidth, theme });

    messages.push({
      id: `diff-auto-${Date.now()}`,
      role: 'system',
      content: diffPreview + '\n' + chalk.gray.dim('  Use /accept, /reject, or /diff to review changes.'),
      timestamp: Date.now(),
    });
  }

  renderDiffForDisplay(sidebarWidth: number, theme: Theme): string | null {
    const unprocessed = this.pendingDiffs.filter(d => !d.accepted && !d.rejected);
    if (unprocessed.length === 0) return null;

    const maxWidth = Math.min((process.stdout.columns || 80) - sidebarWidth - 6, 100);
    return renderMultiFileDiff(unprocessed, this.activeDiffIndex, { maxWidth, theme });
  }

  clear(): void {
    this.pendingDiffs = [];
    this.activeDiffIndex = 0;
  }

  private advanceIndex(): void {
    const start = this.activeDiffIndex;
    for (let i = 0; i < this.pendingDiffs.length; i++) {
      const idx = (start + 1 + i) % this.pendingDiffs.length;
      const d = this.pendingDiffs[idx];
      if (d && !d.accepted && !d.rejected) {
        this.activeDiffIndex = idx;
        return;
      }
    }
  }

  dispose(): void {
    this.terminateWorker();
    this.pendingDiffs = [];
  }
}
