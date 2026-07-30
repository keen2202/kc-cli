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
 * The filesystem scope tools may operate in: the workspace itself plus its
 * sibling directories (projects living next to the workspace). The scope is
 * the workspace's parent directory; at a filesystem root path.dirname reaches
 * its fixed point, so the root itself becomes the boundary.
 *
 * Protected paths (credentials, system files) remain guarded independently by
 * the permission engine, and write tools still go through the ask/deny flow —
 * this boundary only stops traversal far outside the project area.
 */
export function getWorkspaceAccessRoot(cwd: string): string {
  const resolvedCwd = path.resolve(cwd);
  const parent = path.dirname(resolvedCwd);
  return parent === resolvedCwd ? resolvedCwd : parent;
}

/**
 * Synchronous check: does a resolved path stay within the workspace scope
 * (the workspace and its sibling directories)?
 * Rejects path traversal (..) beyond that scope and symlink escape.
 */
export function assertPathWithinWorkspace(filePath: string, cwd: string): void {
  const accessRoot = getWorkspaceAccessRoot(cwd);
  const resolved = path.resolve(cwd, filePath);
  const normalizedRoot = accessRoot.endsWith(path.sep) ? accessRoot : accessRoot + path.sep;

  // Check for path traversal: resolved path must stay within the access root
  if (resolved !== accessRoot && !resolved.startsWith(normalizedRoot)) {
    throw new Error(
      `Path traversal denied: "${filePath}" resolves to "${resolved}" which is outside the workspace scope "${accessRoot}"`
    );
  }

  // Resolve symlinks to prevent TOCTOU attacks where a symlink is
  // substituted between the path check and the file operation
  let realPath: string;
  try {
    realPath = fs.realpathSync.native(resolved);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // File doesn't exist yet — resolve parent directory and verify
      realPath = resolveParentForNewFile(resolved, normalizedRoot);
    } else if ((err as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new Error(
        `Symlink loop detected: "${filePath}" contains a circular symlink reference`
      );
    } else {
      throw err;
    }
  }

  // Check that the real (symlink-resolved) path is still within the scope
  if (realPath !== accessRoot && !realPath.startsWith(normalizedRoot)) {
    throw new Error(
      `Symlink escape denied: "${filePath}" resolves to "${realPath}" which is outside the workspace scope "${accessRoot}"`
    );
  }
}

function resolveParentForNewFile(filePath: string, normalizedRoot: string): string {
  let dir = path.dirname(filePath);

  while (dir !== filePath) {
    try {
      const realDir = fs.realpathSync.native(dir);
      if (realDir !== normalizedRoot.slice(0, -1) && !realDir.startsWith(normalizedRoot)) {
        throw new Error(
          `Symlink escape denied: parent directory "${dir}" resolves to "${realDir}" outside the workspace scope`
        );
      }
      const relative = path.relative(dir, filePath);
      return relative ? path.join(realDir, relative) : realDir;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        dir = path.dirname(dir);
        continue;
      }
      if ((err as NodeJS.ErrnoException).code === 'ELOOP') {
        throw new Error('Symlink loop detected in parent directory path');
      }
      throw err;
    }
  }

  throw new Error(
    `Cannot resolve path for new file: "${filePath}" — no existing parent found`
  );
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
