// Path validation and security

import * as path from 'path';
import * as fs from 'fs';
import { KCError } from './errors';

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
  if (!isWithinAccessRoot(resolved, accessRoot, normalizedRoot)) {
    throw new KCError(
      'tool_permission_denied',
      `Path traversal denied: "${filePath}" resolves to "${resolved}" which is outside the workspace scope "${accessRoot}"`,
      { filePath, resolved, accessRoot }
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
      throw new KCError(
        'tool_permission_denied',
        `Symlink loop detected: "${filePath}" contains a circular symlink reference`,
        { filePath },
        err as Error
      );
    } else {
      throw err;
    }
  }

  // Check that the real (symlink-resolved) path is still within the scope
  if (!isWithinAccessRoot(realPath, accessRoot, normalizedRoot)) {
    throw new KCError(
      'tool_permission_denied',
      `Symlink escape denied: "${filePath}" resolves to "${realPath}" which is outside the workspace scope "${accessRoot}"`,
      { filePath, realPath, accessRoot }
    );
  }
}

/** The path is the access root itself or nested underneath it. */
function isWithinAccessRoot(candidate: string, accessRoot: string, normalizedRoot: string): boolean {
  return candidate === accessRoot || candidate.startsWith(normalizedRoot);
}

function resolveParentForNewFile(filePath: string, normalizedRoot: string): string {
  let dir = path.dirname(filePath);

  while (dir !== filePath) {
    try {
      const realDir = fs.realpathSync.native(dir);
      if (realDir !== normalizedRoot.slice(0, -1) && !realDir.startsWith(normalizedRoot)) {
        throw new KCError(
          'tool_permission_denied',
          `Symlink escape denied: parent directory "${dir}" resolves to "${realDir}" outside the workspace scope`,
          { dir, realDir }
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
        throw new KCError(
          'tool_permission_denied',
          'Symlink loop detected in parent directory path',
          { dir },
          err as Error
        );
      }
      throw err;
    }
  }

  throw new KCError(
    'tool_execution_failed',
    `Cannot resolve path for new file: "${filePath}" — no existing parent found`,
    { filePath }
  );
}
