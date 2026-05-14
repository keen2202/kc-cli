// Path validation and security

import * as path from 'path';
import * as fs from 'fs';
import { isProtectedPath, SYSTEM_WRITE_DIRECTORIES } from '../permissions/protectedPaths';

/**
 * Resolve path safely, handling symlinks before validation
 */
async function resolvePathBeforeCheck(filePath: string, cwd: string): Promise<string> {
  try {
    // Use realpath to resolve symlinks
    return await fs.promises.realpath(filePath);
  } catch {
    // File doesn't exist yet, use normal resolve
    return path.resolve(cwd, filePath);
  }
}

/**
 * Check if path is allowed based on security rules
 */
export async function isPathAllowed(filePath: string, options: {
  cwd: string;
  allowedDirectories?: string[];
  operation: 'read' | 'write' | 'execute';
}): Promise<'allow' | 'deny' | 'ask'> {
  // Resolve symlinks first to prevent bypass
  const resolvedPath = await resolvePathBeforeCheck(filePath, options.cwd);

  // Step 1: Check deny patterns on resolved path
  if (matchesDenyPattern(resolvedPath)) {
    return 'deny';
  }

  // Step 2: Check if in allowed directories (on resolved path)
  if (options.allowedDirectories) {
    for (const allowedDir of options.allowedDirectories) {
      const resolvedAllowedDir = path.resolve(options.cwd, allowedDir);
      const normalizedDir = resolvedAllowedDir.endsWith(path.sep) ? resolvedAllowedDir : resolvedAllowedDir + path.sep;
      if (resolvedPath === resolvedAllowedDir || resolvedPath.startsWith(normalizedDir)) {
        return 'allow';
      }
    }
  }

  // Step 3: Default - ask for permission
  return 'ask';
}

/**
 * Synchronous check: does a resolved path stay within the workspace?
 * Rejects path traversal (..) and symlink escape.
 */
export function assertPathWithinWorkspace(filePath: string, cwd: string): void {
  const resolved = path.resolve(cwd, filePath);
  const normalizedCwd = cwd.endsWith(path.sep) ? cwd : cwd + path.sep;

  // Check for path traversal: resolved path must be within cwd
  if (resolved !== cwd && !resolved.startsWith(normalizedCwd)) {
    throw new Error(
      `Path traversal denied: "${filePath}" resolves to "${resolved}" which is outside workspace "${cwd}"`
    );
  }
}

/**
 * Check if path matches dangerous patterns
 */
function matchesDenyPattern(normalizedPath: string): boolean {
  return isProtectedPath(normalizedPath);
}

/**
 * Resolve symlinks and check for escape attempts
 */
export async function resolvePathSafely(filePath: string, options: {
  cwd: string;
  allowedDirectories: string[];
}): Promise<{ resolvedPath: string; isSafe: boolean; reason?: string }> {
  try {
    const resolvedPath = await fs.promises.realpath(filePath);
    const cwd = path.resolve(options.cwd);

    // Check if resolved path is within allowed directories
    for (const allowedDir of options.allowedDirectories) {
      const resolvedAllowedDir = path.resolve(cwd, allowedDir);
      const normalizedDir = resolvedAllowedDir.endsWith(path.sep) ? resolvedAllowedDir : resolvedAllowedDir + path.sep;
      if (resolvedPath === resolvedAllowedDir || resolvedPath.startsWith(normalizedDir)) {
        return {
          resolvedPath,
          isSafe: true,
        };
      }
    }

    return {
      resolvedPath,
      isSafe: false,
      reason: 'Path escapes allowed directories after symlink resolution',
    };
  } catch (error) {
    // File doesn't exist or can't be resolved
    return {
      resolvedPath: filePath,
      isSafe: false,
      reason: `Failed to resolve path: ${error}`,
    };
  }
}

/**
 * Validate path for write operations
 */
export async function validateWritePath(filePath: string, options: {
  cwd: string;
  allowedDirectories: string[];
}): Promise<{ valid: boolean; reason?: string }> {
  // Resolve symlinks first
  const resolvedPath = await resolvePathBeforeCheck(filePath, options.cwd);

  // Prevent writing to system directories (check resolved path)
  for (const sysDir of SYSTEM_WRITE_DIRECTORIES) {
    if (resolvedPath.startsWith(sysDir)) {
      return {
        valid: false,
        reason: 'Cannot write to system directories',
      };
    }
  }

  // Check allowed directories (on resolved path)
  for (const allowedDir of options.allowedDirectories) {
    const resolvedAllowedDir = path.resolve(options.cwd, allowedDir);
    const normalizedDir = resolvedAllowedDir.endsWith(path.sep) ? resolvedAllowedDir : resolvedAllowedDir + path.sep;
    if (resolvedPath === resolvedAllowedDir || resolvedPath.startsWith(normalizedDir)) {
      return { valid: true };
    }
  }

  return {
    valid: false,
    reason: 'Path not in allowed directories',
  };
}
