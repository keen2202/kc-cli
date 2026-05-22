// Memory path management and security validation

import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';

const KC_CLI_BASE_DIR = '.kc-cli';
const MEMORY_DIR = 'memory';
const SESSIONS_DIR = 'sessions';
const ARCHIVE_DIR = '.archive';

/**
 * Get the base kc-cli directory path (~/.kc-cli/)
 */
export function getKcCliBasePath(): string {
  return path.join(os.homedir(), KC_CLI_BASE_DIR);
}

/**
 * Get the memory base directory (~/.kc-cli/memory/)
 */
export function getMemoryBasePath(): string {
  return path.join(getKcCliBasePath(), MEMORY_DIR);
}

/**
 * Get the project-specific memory directory (~/.kc-cli/memory/<project-hash>/)
 */
export function getProjectMemoryPath(projectHash: string): string {
  const sanitized = sanitizeProjectHash(projectHash);
  return path.join(getMemoryBasePath(), sanitized);
}

/**
 * Get the full path to a memory file
 */
export function getMemoryFilePath(projectHash: string, fileName: string): string {
  const projectPath = getProjectMemoryPath(projectHash);
  const safeFileName = sanitizeFileName(fileName);
  return path.join(projectPath, safeFileName);
}

/**
 * Get the session base directory (~/.kc-cli/sessions/)
 */
export function getSessionBasePath(): string {
  return path.join(getKcCliBasePath(), SESSIONS_DIR);
}

/**
 * Get the archive directory (~/.kc-cli/sessions/.archive/)
 */
export function getArchivePath(): string {
  return path.join(getSessionBasePath(), ARCHIVE_DIR);
}

/**
 * Get the full path to a session snapshot file
 */
export function getSessionPath(sessionId: string): string {
  const safeId = sanitizeFileName(sessionId);
  return path.join(getSessionBasePath(), `${safeId}.json`);
}

/**
 * Get the archive path for a session
 */
export function getSessionArchivePath(sessionId: string): string {
  const safeId = sanitizeFileName(sessionId);
  return path.join(getArchivePath(), `${safeId}.json`);
}

/**
 * Get the consolidation lock file path
 */
export function getConsolidateLockPath(projectHash: string): string {
  const projectPath = getProjectMemoryPath(projectHash);
  return path.join(projectPath, '.consolidate-lock');
}

/**
 * Ensure the memory directory structure exists for a project
 */
export async function ensureMemoryDir(projectHash: string): Promise<void> {
  const projectPath = getProjectMemoryPath(projectHash);
  await fs.mkdir(projectPath, { recursive: true });
}

/**
 * Ensure the session directory structure exists
 */
export async function ensureSessionDirs(): Promise<void> {
  // Archive path is a child of session path, so mkdir session first, then archive
  await fs.mkdir(getSessionBasePath(), { recursive: true });
  await fs.mkdir(getArchivePath(), { recursive: true });
}

/**
 * Validate that a path is safe and doesn't escape the memory directory
 * Security: prevents directory traversal, symlink attacks, Unicode normalization issues
 */
export async function validateMemoryPath(
  fullPath: string,
  baseDir: string
): Promise<boolean> {
  // Normalize paths
  const normalizedFull = path.normalize(fullPath);
  const normalizedBase = path.normalize(baseDir);

  // Check for directory traversal attempts
  if (normalizedFull.includes('..')) {
    return false;
  }

  // Ensure the path is within the base directory
  const relativePath = path.relative(normalizedBase, normalizedFull);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return false;
  }

  // Check if file exists and validate symlinks
  try {
    const stat = await fs.lstat(normalizedFull);

    // If it's a symlink, resolve and validate target
    if (stat.isSymbolicLink()) {
      const realPath = await fs.realpath(normalizedFull);
      const relativeTarget = path.relative(normalizedBase, realPath);
      if (relativeTarget.startsWith('..') || path.isAbsolute(relativeTarget)) {
        return false;
      }
    }
  } catch {
    // File doesn't exist yet - validate the parent directory
    const parentDir = path.dirname(normalizedFull);
    const relativeParent = path.relative(normalizedBase, parentDir);
    if (relativeParent.startsWith('..') || path.isAbsolute(relativeParent)) {
      return false;
    }
  }

  return true;
}

/**
 * Validate a file name for safety
 */
export function sanitizeFileName(fileName: string): string {
  // Normalize Unicode
  let safe = fileName.normalize('NFC');

  // Remove directory traversal
  safe = safe.replace(/\.\./g, '');

  // Remove path separators
  safe = safe.replace(/[\\/]/g, '_');

  // Remove null bytes
  safe = safe.replace(/\0/g, '');

  // Only allow safe characters, dots, hyphens, and underscores
  safe = safe.replace(/[^a-zA-Z0-9._-]/g, '_');

  // Ensure it ends with .md for memory files
  if (!safe.endsWith('.md') && !safe.endsWith('.json') && !safe.endsWith('.lock')) {
    safe += '.md';
  }

  // Limit length
  if (safe.length > 255) {
    const ext = path.extname(safe);
    safe = safe.substring(0, 255 - ext.length) + ext;
  }

  return safe;
}

/**
 * Sanitize a project hash for use in directory names
 */
export function sanitizeProjectHash(hash: string): string {
  // Only allow alphanumeric characters and hyphens
  return hash.replace(/[^a-zA-Z0-9-]/g, '_');
}

/**
 * Get allowed file extensions for memory files
 */
export const ALLOWED_MEMORY_EXTENSIONS = ['.md'];
export const ALLOWED_SESSION_EXTENSIONS = ['.json'];
export const ALLOWED_LOCK_EXTENSIONS = ['.lock'];

/**
 * Check if a file has an allowed extension
 */
export function hasAllowedExtension(fileName: string, allowed: string[]): boolean {
  const ext = path.extname(fileName).toLowerCase();
  return allowed.includes(ext);
}

/**
 * Create a .gitignore file in the memory directory if it doesn't exist
 */
export async function ensureGitignore(basePath: string): Promise<void> {
  const gitignorePath = path.join(basePath, '.gitignore');
  try {
    await fs.access(gitignorePath);
  } catch {
    // File doesn't exist, create it
    const gitignoreContent = `# kc-cli memory and session data
# Contains conversation transcripts and extracted memories
memory/
sessions/
*.json
*.md
!.gitignore
`;
    await fs.writeFile(gitignorePath, gitignoreContent, 'utf-8');
  }
}
