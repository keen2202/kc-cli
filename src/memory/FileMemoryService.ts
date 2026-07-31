// Filesystem-based memory service implementation

import * as fs from 'fs/promises';
import * as path from 'path';
import type {
  MemoryEntry,
  MemoryHeader,
  MemoryService,
  MemoryType,
  SessionFilter,
  SessionSnapshot,
} from './types';
import {
  getProjectMemoryPath,
  getMemoryFilePath,
  getSessionPath,
  getSessionArchivePath,
  getSessionBasePath,
  getArchivePath,
  ensureMemoryDir,
  ensureSessionDirs,
  validateMemoryPath,
  sanitizeFileName,
  ALLOWED_MEMORY_EXTENSIONS,
  ALLOWED_SESSION_EXTENSIONS,
  ensureGitignore,
  getKcCliBasePath,
} from './paths';
import { KCError } from '../utils/errors';
import { parseFrontmatter, composeMemoryFile, validateMemoryType } from './frontmatter';
import { invalidateScoreCache } from './relevanceSearch';

export class FileMemoryService implements MemoryService {
  /**
   * Initialize the memory service - ensure directories exist
   */
  async initialize(): Promise<void> {
    await ensureSessionDirs();

    // Create base memory directory and ensure .gitignore in parallel (independent operations)
    const memoryBasePath = path.join(getKcCliBasePath(), 'memory');
    await Promise.all([
      fs.mkdir(memoryBasePath, { recursive: true }),
      ensureGitignore(getKcCliBasePath()),
    ]);
  }

  // ==================== Memory Operations ====================

  /**
   * Add a new memory file
   * Returns the file name that was created
   */
  async addMemory(projectHash: string, memory: MemoryEntry): Promise<string> {
    await ensureMemoryDir(projectHash);

    const fileName = sanitizeFileName(memory.fileName || `${memory.header.name}.md`);
    const filePath = getMemoryFilePath(projectHash, fileName);

    // Validate path security
    const projectPath = getProjectMemoryPath(projectHash);
    const isValid = await validateMemoryPath(filePath, projectPath);
    if (!isValid) {
      throw new Error(`Invalid memory path: ${filePath}`);
    }

    // Compose and write the file
    const header: MemoryHeader = {
      name: memory.header.name,
      description: memory.header.description,
      type: memory.header.type,
      createdAt: memory.header.createdAt || Date.now(),
      updatedAt: memory.header.updatedAt || Date.now(),
      confidence: memory.header.confidence,
      // T8: preserve the failure signature so scanner/manifest dedup keeps
      // matching bridged memories across sessions.
      signature: memory.header.signature,
    };

    const content = composeMemoryFile(header, memory.content);

    // Atomic write: write to temp file, then rename
    const tempPath = `${filePath}.tmp`;
    await fs.writeFile(tempPath, content, 'utf-8');
    await fs.rename(tempPath, filePath);

    invalidateScoreCache();
    return fileName;
  }

  /**
   * List all memory files for a project, optionally filtered by type
   */
  async listMemories(projectHash: string, type?: MemoryType): Promise<MemoryEntry[]> {
    const projectPath = getProjectMemoryPath(projectHash);

    try {
      await fs.access(projectPath);
    } catch {
      // Directory doesn't exist, return empty array
      return [];
    }

    const files = await this.scanDirectory(projectPath);

    if (type) {
      return files.filter((m) => m.header.type === type);
    }

    return files;
  }

  /**
   * Get a specific memory file
   */
  async getMemory(projectHash: string, fileName: string): Promise<MemoryEntry | null> {
    const projectPath = getProjectMemoryPath(projectHash);
    const filePath = getMemoryFilePath(projectHash, fileName);

    // Validate path security
    const isValid = await validateMemoryPath(filePath, projectPath);
    if (!isValid) {
      throw new Error(`Invalid memory path: ${filePath}`);
    }

    try {
      const [content, stat] = await Promise.all([
        fs.readFile(filePath, 'utf-8'),
        fs.stat(filePath),
      ]);
      const { header, body } = parseFrontmatter(content);

      if (!header.name || !header.type) {
        return null; // Invalid frontmatter
      }

      const memoryType = validateMemoryType(header.type);
      if (!memoryType) {
        return null; // Invalid type
      }

      return {
        header: {
          name: header.name,
          description: header.description || '',
          type: memoryType,
          createdAt: header.createdAt,
          updatedAt: header.updatedAt,
          confidence: header.confidence,
          // T8: surface the failure signature to bridging/dedup consumers.
          signature: header.signature,
        },
        content: body,
        filePath,
        fileName: path.basename(filePath),
        mtime: stat.mtimeMs,
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw err;
    }
  }

  /**
   * Remove a memory file
   */
  async removeMemory(projectHash: string, fileName: string): Promise<void> {
    const projectPath = getProjectMemoryPath(projectHash);
    const filePath = getMemoryFilePath(projectHash, fileName);

    // Validate path security
    const isValid = await validateMemoryPath(filePath, projectPath);
    if (!isValid) {
      throw new Error(`Invalid memory path: ${filePath}`);
    }

    try {
      await fs.unlink(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
    }

    invalidateScoreCache();
  }

  /**
   * Update an existing memory file
   */
  async updateMemory(
    projectHash: string,
    fileName: string,
    updates: Partial<MemoryEntry>
  ): Promise<void> {
    const existing = await this.getMemory(projectHash, fileName);
    if (!existing) {
      throw new KCError('session_not_found', `Memory not found: ${fileName}`, { fileName });
    }

    const merged: MemoryEntry = {
      ...existing,
      header: {
        ...existing.header,
        ...(updates.header || {}),
        updatedAt: Date.now(),
      },
      content: updates.content ?? existing.content,
    };

    const filePath = getMemoryFilePath(projectHash, fileName);
    const content = composeMemoryFile(merged.header, merged.content);

    // Atomic write
    const tempPath = `${filePath}.tmp`;
    await fs.writeFile(tempPath, content, 'utf-8');
    await fs.rename(tempPath, filePath);

    invalidateScoreCache();
  }

  // ==================== Session Operations ====================

  /**
   * Save a session snapshot
   */
  async saveSession(session: SessionSnapshot): Promise<void> {
    await ensureSessionDirs();

    const filePath = getSessionPath(session.sessionId);
    const content = JSON.stringify(session, null, 2);

    // Atomic write
    const tempPath = `${filePath}.tmp`;
    await fs.writeFile(tempPath, content, 'utf-8');
    await fs.rename(tempPath, filePath);
  }

  /**
   * Load a session snapshot
   */
  async loadSession(sessionId: string): Promise<SessionSnapshot | null> {
    const filePath = getSessionPath(sessionId);

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(content) as SessionSnapshot;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // Try archive
        return this.loadArchivedSession(sessionId);
      }
      throw err;
    }
  }

  /**
   * List sessions with optional filter
   */
  async listSessions(filter?: SessionFilter): Promise<SessionSnapshot[]> {
    const sessionDir = getSessionBasePath();

    try {
      await fs.access(sessionDir);
    } catch {
      return [];
    }

    const files = await fs.readdir(sessionDir);
    const jsonFiles = files.filter((f) => f.endsWith('.json'));

    const sessions: SessionSnapshot[] = [];

    for (const file of jsonFiles) {
      try {
        const filePath = path.join(sessionDir, file);
        const [stat, content] = await Promise.all([
          fs.stat(filePath),
          fs.readFile(filePath, 'utf-8'),
        ]);
        const session = JSON.parse(content) as SessionSnapshot;

        // Apply filters
        if (filter?.newerThan && stat.mtimeMs < filter.newerThan) continue;
        if (filter?.olderThan && stat.mtimeMs > filter.olderThan) continue;

        sessions.push(session);
      } catch {
        // Skip invalid files
        continue;
      }
    }

    // Sort by lastModified descending
    sessions.sort((a, b) => b.metadata.lastModified - a.metadata.lastModified);

    // Apply limit
    if (filter?.limit) {
      sessions.length = Math.min(sessions.length, filter.limit);
    }

    return sessions;
  }

  /**
   * Delete a session permanently
   */
  async deleteSession(sessionId: string): Promise<void> {
    const filePath = getSessionPath(sessionId);
    const archivePath = getSessionArchivePath(sessionId);

    // Delete from both locations if exists
    for (const p of [filePath, archivePath]) {
      try {
        await fs.unlink(p);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw err;
        }
      }
    }
  }

  /**
   * Archive a session
   */
  async archiveSession(sessionId: string): Promise<void> {
    const sourcePath = getSessionPath(sessionId);
    const targetPath = getSessionArchivePath(sessionId);

    await ensureSessionDirs();

    try {
      // Move to archive
      await fs.rename(sourcePath, targetPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new KCError('session_not_found', `Session not found: ${sessionId}`, { sessionId });
      }
      throw err;
    }
  }

  /**
   * Prune old sessions beyond retention period.
   * @param retentionDays - Retention for active sessions (default 30 days)
   * @param archiveRetentionDays - Retention for archived sessions (default 90 days). Omit to skip archive pruning.
   */
  async pruneOldSessions(retentionDays: number, archiveRetentionDays?: number): Promise<number> {
    const cutoffTime = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const sessions = await this.listSessions();

    let prunedCount = 0;

    // Prune active sessions
    for (const session of sessions) {
      if (session.metadata.lastModified < cutoffTime) {
        await this.deleteSession(session.sessionId);
        prunedCount++;
      }
    }

    // Prune archived sessions
    if (archiveRetentionDays !== undefined) {
      const archiveCutoff = Date.now() - archiveRetentionDays * 24 * 60 * 60 * 1000;
      const archiveDir = getArchivePath();

      try {
        const archiveFiles = await fs.readdir(archiveDir);
        for (const file of archiveFiles) {
          if (!file.endsWith('.json')) continue;
          const filePath = path.join(archiveDir, file);
          try {
            const stat = await fs.stat(filePath);
            if (stat.mtimeMs < archiveCutoff) {
              await fs.unlink(filePath);
              prunedCount++;
            }
          } catch {
            // Skip files that can't be stat'd or deleted
          }
        }
      } catch {
        // Archive directory doesn't exist yet — nothing to prune
      }
    }

    return prunedCount;
  }

  // ==================== Utility Operations ====================

  /**
   * Get the project memory path
   */
  getProjectMemoryPath(projectHash: string): string {
    return getProjectMemoryPath(projectHash);
  }

  /**
   * Scan and list all memory files for a project
   */
  async scanMemories(projectHash: string, limit: number = 200): Promise<MemoryEntry[]> {
    const projectPath = getProjectMemoryPath(projectHash);

    try {
      await fs.access(projectPath);
    } catch {
      return [];
    }

    return this.scanDirectory(projectPath, limit);
  }

  // ==================== Private Helpers ====================

  /**
   * Scan a directory for memory files and parse their frontmatter
   */
  private async scanDirectory(dirPath: string, limit: number = 200): Promise<MemoryEntry[]> {
    const files = await fs.readdir(dirPath);
    const mdFiles = files.filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');

    const entries: MemoryEntry[] = [];

    for (const file of mdFiles) {
      try {
        const filePath = path.join(dirPath, file);
        const [stat, content] = await Promise.all([
          fs.stat(filePath),
          fs.readFile(filePath, 'utf-8'),
        ]);
        const { header, body } = parseFrontmatter(content);

        if (!header.name || !header.type) continue;

        const memoryType = validateMemoryType(header.type);
        if (!memoryType) continue;

        entries.push({
          header: {
            name: header.name,
            description: header.description || '',
            type: memoryType,
            createdAt: header.createdAt,
            updatedAt: header.updatedAt,
            confidence: header.confidence,
            // T8: surface the failure signature to bridging/dedup consumers.
            signature: header.signature,
          },
          content: body,
          filePath,
          fileName: file,
          mtime: stat.mtimeMs,
        });
      } catch {
        // Skip invalid files
        continue;
      }

      if (entries.length >= limit) break;
    }

    // Sort by mtime descending (newest first)
    entries.sort((a, b) => b.mtime - a.mtime);

    return entries;
  }

  /**
   * Load an archived session
   */
  private async loadArchivedSession(sessionId: string): Promise<SessionSnapshot | null> {
    const archivePath = getSessionArchivePath(sessionId);

    try {
      const content = await fs.readFile(archivePath, 'utf-8');
      return JSON.parse(content) as SessionSnapshot;
    } catch {
      return null;
    }
  }
}
