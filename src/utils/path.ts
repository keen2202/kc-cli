// Path validation and security

import * as path from 'path';
import * as fs from 'fs';
import { isProtectedPath, SYSTEM_WRITE_DIRECTORIES } from '../permissions/protectedPaths';

/**
 * Check if path is allowed based on security rules
 */
export function isPathAllowed(filePath: string, options: {
  cwd: string;
  allowedDirectories?: string[];
  operation: 'read' | 'write' | 'execute';
}): 'allow' | 'deny' | 'ask' {
  const normalizedPath = path.resolve(options.cwd, filePath);

  // Step 1: Check deny patterns
  if (matchesDenyPattern(normalizedPath)) {
    return 'deny';
  }

  // Step 2: Check if in allowed directories
  if (options.allowedDirectories) {
    for (const allowedDir of options.allowedDirectories) {
      if (normalizedPath.startsWith(path.resolve(options.cwd, allowedDir))) {
        return 'allow';
      }
    }
  }

  // Step 3: Default - ask for permission
  return 'ask';
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
      if (resolvedPath.startsWith(resolvedAllowedDir)) {
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
export function validateWritePath(filePath: string, options: {
  cwd: string;
  allowedDirectories: string[];
}): { valid: boolean; reason?: string } {
  const normalizedPath = path.resolve(options.cwd, filePath);

  // Prevent writing to system directories
  for (const sysDir of SYSTEM_WRITE_DIRECTORIES) {
    if (normalizedPath.startsWith(sysDir)) {
      return {
        valid: false,
        reason: 'Cannot write to system directories',
      };
    }
  }

  // Check allowed directories
  for (const allowedDir of options.allowedDirectories) {
    const resolvedAllowedDir = path.resolve(options.cwd, allowedDir);
    if (normalizedPath.startsWith(resolvedAllowedDir)) {
      return { valid: true };
    }
  }

  return {
    valid: false,
    reason: 'Path not in allowed directories',
  };
}
