// Shared directory traversal utility for GlobTool and GrepTool

import * as fs from 'fs';
import * as path from 'path';

export interface WalkEntry {
  fullPath: string;
  relativePath: string;
  name: string;
  isDirectory: boolean;
}

export interface WalkOptions {
  /** Maximum number of files to accumulate */
  maxResults?: number;
  /** Directory names to skip during traversal */
  skipDirs?: string[];
  /** Base directory to compute relative paths from */
  baseDir: string;
  /** Called for each file. Return false to stop traversal. */
  onFile?: (entry: WalkEntry) => Promise<boolean | void>;
  /** Called for each dir. Return false to skip traversal into that dir. */
  onDir?: (entry: WalkEntry) => Promise<boolean | void>;
}

const DEFAULT_SKIP_DIRS = ['node_modules', '.git', '.svn', '.hg'];

/**
 * Recursively walk a directory tree, calling callbacks for each file and directory.
 * Skips hidden directories (names starting with '.') and entries in skipDirs by default.
 */
export async function walkDirectory(
  rootDir: string,
  options: WalkOptions
): Promise<void> {
  const {
    maxResults = Infinity,
    skipDirs = DEFAULT_SKIP_DIRS,
    baseDir,
    onFile,
    onDir,
  } = options;

  let fileCount = 0;
  const skipSet = new Set(skipDirs);

  async function walk(dir: string): Promise<void> {
    if (fileCount >= maxResults) return;

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return; // Skip unreadable directories
    }

    for (const entry of entries) {
      if (fileCount >= maxResults) break;

      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(baseDir, fullPath);

      if (entry.isDirectory()) {
        // Skip hidden directories and configured skip dirs
        if (entry.name.startsWith('.') || skipSet.has(entry.name)) continue;

        const walkEntry: WalkEntry = {
          fullPath,
          relativePath,
          name: entry.name,
          isDirectory: true,
        };

        const shouldEnter = onDir ? await onDir(walkEntry) : true;
        if (shouldEnter !== false) {
          await walk(fullPath);
        }
      } else if (entry.isFile()) {
        const walkEntry: WalkEntry = {
          fullPath,
          relativePath,
          name: entry.name,
          isDirectory: false,
        };

        if (onFile) {
          const shouldContinue = await onFile(walkEntry);
          fileCount++;
          if (shouldContinue === false) return;
        }
      }
    }
  }

  await walk(rootDir);
}
