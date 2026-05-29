import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';

// ---------------------------------------------------------------------------
// Mock fs/promises and os before importing the module under test
// ---------------------------------------------------------------------------
const {
  mockMkdir,
  mockLstat,
  mockRealpath,
  mockAccess,
  mockWriteFile,
} = vi.hoisted(() => ({
  mockMkdir: vi.fn(),
  mockLstat: vi.fn(),
  mockRealpath: vi.fn(),
  mockAccess: vi.fn(),
  mockWriteFile: vi.fn(),
}));

vi.mock('fs/promises', () => ({
  mkdir: mockMkdir,
  lstat: mockLstat,
  realpath: mockRealpath,
  access: mockAccess,
  writeFile: mockWriteFile,
}));

vi.mock('os', () => ({
  homedir: () => '/home/test',
}));

// ---------------------------------------------------------------------------
// Import the module under test
// ---------------------------------------------------------------------------
import {
  getKcCliBasePath,
  getMemoryBasePath,
  getProjectMemoryPath,
  getMemoryFilePath,
  getSessionBasePath,
  getArchivePath,
  getSessionPath,
  getSessionArchivePath,
  getConsolidateLockPath,
  ensureMemoryDir,
  ensureSessionDirs,
  ensureGitignore,
  validateMemoryPath,
  sanitizeFileName,
  sanitizeProjectHash,
  hasAllowedExtension,
  ALLOWED_MEMORY_EXTENSIONS,
  ALLOWED_SESSION_EXTENSIONS,
  ALLOWED_LOCK_EXTENSIONS,
} from '../../src/memory/paths';

// ---------------------------------------------------------------------------
// Constants used across tests
// ---------------------------------------------------------------------------
const KC_CLI_BASE = '/home/test/.kc-cli';
const MEMORY_BASE = path.join(KC_CLI_BASE, 'memory');
const SESSION_BASE = path.join(KC_CLI_BASE, 'sessions');
const ARCHIVE_BASE = path.join(SESSION_BASE, '.archive');

// ===========================================================================
// Tests
// ===========================================================================
describe('memory paths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // Path construction
  // -----------------------------------------------------------------------
  describe('path construction', () => {
    it('getKcCliBasePath returns ~/.kc-cli', () => {
      expect(getKcCliBasePath()).toBe(KC_CLI_BASE);
    });

    it('getMemoryBasePath returns ~/.kc-cli/memory', () => {
      expect(getMemoryBasePath()).toBe(MEMORY_BASE);
    });

    it('getProjectMemoryPath constructs path from a plain hash', () => {
      expect(getProjectMemoryPath('abc123')).toBe(path.join(MEMORY_BASE, 'abc123'));
    });

    it('getProjectMemoryPath sanitizes hash characters', () => {
      expect(getProjectMemoryPath('abc/def')).toBe(path.join(MEMORY_BASE, 'abc_def'));
    });

    it('getProjectMemoryPath replaces multiple unsafe hash characters', () => {
      expect(getProjectMemoryPath('abc.def@ghi')).toBe(path.join(MEMORY_BASE, 'abc_def_ghi'));
    });

    it('getMemoryFilePath constructs full file path', () => {
      expect(getMemoryFilePath('abc123', 'note.md')).toBe(
        path.join(MEMORY_BASE, 'abc123', 'note.md'),
      );
    });

    it('getMemoryFilePath sanitizes file name', () => {
      // '../note.md' -> remove '..' -> '/note.md' -> replace '/' -> '_note.md'
      expect(getMemoryFilePath('abc123', '../note.md')).toBe(
        path.join(MEMORY_BASE, 'abc123', '_note.md'),
      );
    });

    it('getSessionBasePath returns sessions directory', () => {
      expect(getSessionBasePath()).toBe(SESSION_BASE);
    });

    it('getArchivePath returns sessions/.archive directory', () => {
      expect(getArchivePath()).toBe(ARCHIVE_BASE);
    });

    it('getSessionPath returns path with sanitized id and .json suffix', () => {
      const result = getSessionPath('sess-123');
      const safeId = sanitizeFileName('sess-123');
      expect(result).toBe(path.join(SESSION_BASE, `${safeId}.json`));
    });

    it('getSessionArchivePath returns archive path with .json suffix', () => {
      const result = getSessionArchivePath('sess-123');
      const safeId = sanitizeFileName('sess-123');
      expect(result).toBe(path.join(ARCHIVE_BASE, `${safeId}.json`));
    });

    it('getConsolidateLockPath returns lock file inside project memory dir', () => {
      expect(getConsolidateLockPath('abc123')).toBe(
        path.join(MEMORY_BASE, 'abc123', '.consolidate-lock'),
      );
    });

    it('getConsolidateLockPath sanitizes hash', () => {
      expect(getConsolidateLockPath('abc/123')).toBe(
        path.join(MEMORY_BASE, 'abc_123', '.consolidate-lock'),
      );
    });
  });

  // -----------------------------------------------------------------------
  // sanitizeFileName
  // -----------------------------------------------------------------------
  describe('sanitizeFileName', () => {
    it('preserves a safe .md filename', () => {
      expect(sanitizeFileName('my-memory.md')).toBe('my-memory.md');
    });

    it('preserves a .json filename', () => {
      expect(sanitizeFileName('session.json')).toBe('session.json');
    });

    it('preserves a .lock filename', () => {
      expect(sanitizeFileName('data.lock')).toBe('data.lock');
    });

    it('appends .md when no recognised extension is present', () => {
      expect(sanitizeFileName('untitled')).toBe('untitled.md');
    });

    it('appends .md for a non-recognised extension (.txt)', () => {
      expect(sanitizeFileName('readme.txt')).toBe('readme.txt.md');
    });

    it('removes simple .. directory traversal', () => {
      // '../note.md' -> remove '..' -> '/note.md' -> replace '/' -> '_note.md'
      expect(sanitizeFileName('../note.md')).toBe('_note.md');
    });

    it('removes multiple .. sequences', () => {
      expect(sanitizeFileName('../../../etc/passwd.md')).toBe('___etc_passwd.md');
    });

    it('removes .. from a triple-dot prefix', () => {
      expect(sanitizeFileName('...md')).toBe('.md');
    });

    it('replaces forward slashes with underscores', () => {
      expect(sanitizeFileName('dir/file.md')).toBe('dir_file.md');
    });

    it('replaces backslashes with underscores', () => {
      expect(sanitizeFileName('dir\\file.md')).toBe('dir_file.md');
    });

    it('removes null bytes', () => {
      expect(sanitizeFileName('fi\0le.md')).toBe('file.md');
    });

    it('replaces unsafe characters with underscores', () => {
      expect(sanitizeFileName('hello#world$file%name^.md')).toBe(
        'hello_world_file_name_.md',
      );
    });

    it('replaces spaces with underscores', () => {
      expect(sanitizeFileName('my note.md')).toBe('my_note.md');
    });

    it('replaces special symbols with underscores', () => {
      expect(sanitizeFileName('file@name!.md')).toBe('file_name_.md');
    });

    it('truncates beyond 255 chars and adds .md when no extension present', () => {
      const longName = 'a'.repeat(300);
      const result = sanitizeFileName(longName);
      expect(result).toBe('a'.repeat(252) + '.md');
      expect(result.length).toBe(255);
    });

    it('truncates beyond 255 chars preserving .json extension', () => {
      const longName = 'a'.repeat(300) + '.json';
      const result = sanitizeFileName(longName);
      expect(result).toBe('a'.repeat(250) + '.json');
      expect(result.length).toBe(255);
    });

    it('truncates beyond 255 chars preserving .lock extension', () => {
      const longName = 'a'.repeat(300) + '.lock';
      const result = sanitizeFileName(longName);
      expect(result).toBe('a'.repeat(250) + '.lock');
      expect(result.length).toBe(255);
    });

    it('truncates beyond 255 chars preserving .md extension', () => {
      const longName = 'a'.repeat(300) + '.md';
      const result = sanitizeFileName(longName);
      expect(result).toBe('a'.repeat(252) + '.md');
      expect(result.length).toBe(255);
    });

    it('NFC normalises Unicode so decomposed and composed forms match', () => {
      // U+0041 (A) + U+0300 (combining grave) -- NFD of À
      const nfdInput = 'À';
      // U+00C0 (À) -- NFC form
      const nfcInput = 'À';
      expect(sanitizeFileName(nfdInput)).toBe(sanitizeFileName(nfcInput));
    });

    it('handles empty string', () => {
      expect(sanitizeFileName('')).toBe('.md');
    });

    it('handles a string of only dots', () => {
      // '...' -> remove '..' -> '.' -> append '.md' -> '..md'
      expect(sanitizeFileName('...')).toBe('..md');
    });

    it('preserves mixed safe characters (letters, digits, dots, hyphens, underscores)', () => {
      expect(sanitizeFileName('hello-world.test_file.123.md')).toBe(
        'hello-world.test_file.123.md',
      );
    });

    it('appends .md after processing for a multi-dot name without recognised extension', () => {
      expect(sanitizeFileName('a.b.c.txt')).toBe('a.b.c.txt.md');
    });
  });

  // -----------------------------------------------------------------------
  // sanitizeProjectHash
  // -----------------------------------------------------------------------
  describe('sanitizeProjectHash', () => {
    it('preserves alphanumeric characters and hyphens', () => {
      expect(sanitizeProjectHash('abc123-def456')).toBe('abc123-def456');
    });

    it('replaces dots with underscores', () => {
      expect(sanitizeProjectHash('abc.def')).toBe('abc_def');
    });

    it('replaces forward slashes with underscores', () => {
      expect(sanitizeProjectHash('abc/def')).toBe('abc_def');
    });

    it('replaces spaces with underscores', () => {
      expect(sanitizeProjectHash('abc def')).toBe('abc_def');
    });

    it('replaces all unsafe special characters with underscores', () => {
      expect(sanitizeProjectHash('abc@#$%^&*()')).toBe('abc_________');
    });

    it('handles empty string', () => {
      expect(sanitizeProjectHash('')).toBe('');
    });

    it('handles a string with no safe characters', () => {
      expect(sanitizeProjectHash('!@#$%')).toBe('_____');
    });
  });

  // -----------------------------------------------------------------------
  // validateMemoryPath
  // -----------------------------------------------------------------------
  describe('validateMemoryPath', () => {
    const BASE = '/home/test/.kc-cli/memory';

    it('returns true for a regular file inside the base directory', async () => {
      mockLstat.mockResolvedValue({ isSymbolicLink: () => false });
      const filePath = path.join(BASE, 'abc123', 'note.md');
      await expect(validateMemoryPath(filePath, BASE)).resolves.toBe(true);
    });

    it('returns true when path is the base directory itself', async () => {
      mockLstat.mockResolvedValue({ isSymbolicLink: () => false });
      await expect(validateMemoryPath(BASE, BASE)).resolves.toBe(true);
    });

    it('returns false when the normalised path contains ".." as a substring', async () => {
      // A filename like '...md' survives path.normalize() and still contains '..'
      const filePath = path.join(BASE, 'abc123', '...md');
      await expect(validateMemoryPath(filePath, BASE)).resolves.toBe(false);
    });

    it('returns false for a path that traverses outside the base', async () => {
      mockLstat.mockResolvedValue({ isSymbolicLink: () => false });
      await expect(validateMemoryPath('/etc/passwd', BASE)).resolves.toBe(false);
    });

    it('returns false for a symlink that resolves outside the base', async () => {
      mockLstat.mockResolvedValue({ isSymbolicLink: () => true });
      mockRealpath.mockResolvedValue('/etc/passwd');
      const filePath = path.join(BASE, 'abc123', 'link.md');
      await expect(validateMemoryPath(filePath, BASE)).resolves.toBe(false);
    });

    it('returns true for a symlink that resolves inside the base', async () => {
      mockLstat.mockResolvedValue({ isSymbolicLink: () => true });
      const targetPath = path.join(BASE, 'abc123', 'real.md');
      mockRealpath.mockResolvedValue(targetPath);
      const filePath = path.join(BASE, 'abc123', 'link.md');
      await expect(validateMemoryPath(filePath, BASE)).resolves.toBe(true);
    });

    it('validates the parent directory when the file does not exist (ENOENT)', async () => {
      mockLstat.mockRejectedValue(new Error('ENOENT'));
      const filePath = path.join(BASE, 'abc123', 'new.md');
      await expect(validateMemoryPath(filePath, BASE)).resolves.toBe(true);
    });

    it('returns false for a non-existent file whose parent is outside the base', async () => {
      mockLstat.mockRejectedValue(new Error('ENOENT'));
      await expect(validateMemoryPath('/etc/new.md', BASE)).resolves.toBe(false);
    });

    it('handles non-ENOENT lstat errors by validating the parent directory', async () => {
      mockLstat.mockRejectedValue(new Error('EACCES'));
      const filePath = path.join(BASE, 'abc123', 'new.md');
      await expect(validateMemoryPath(filePath, BASE)).resolves.toBe(true);
    });

    it('returns false for non-ENOENT lstat error with parent outside base', async () => {
      mockLstat.mockRejectedValue(new Error('EACCES'));
      await expect(validateMemoryPath('/etc/new.md', BASE)).resolves.toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // hasAllowedExtension
  // -----------------------------------------------------------------------
  describe('hasAllowedExtension', () => {
    it('returns true for .md with memory extensions', () => {
      expect(hasAllowedExtension('file.md', ALLOWED_MEMORY_EXTENSIONS)).toBe(true);
    });

    it('returns false for .txt with memory extensions', () => {
      expect(hasAllowedExtension('file.txt', ALLOWED_MEMORY_EXTENSIONS)).toBe(false);
    });

    it('returns true for .json with session extensions', () => {
      expect(hasAllowedExtension('session.json', ALLOWED_SESSION_EXTENSIONS)).toBe(true);
    });

    it('returns false for .md with session extensions', () => {
      expect(hasAllowedExtension('session.md', ALLOWED_SESSION_EXTENSIONS)).toBe(false);
    });

    it('returns true for .lock with lock extensions', () => {
      expect(hasAllowedExtension('data.lock', ALLOWED_LOCK_EXTENSIONS)).toBe(true);
    });

    it('is case-insensitive (.MD matches .md)', () => {
      expect(hasAllowedExtension('file.MD', ALLOWED_MEMORY_EXTENSIONS)).toBe(true);
    });

    it('is case-insensitive (.Json matches .json)', () => {
      expect(hasAllowedExtension('file.Json', ALLOWED_SESSION_EXTENSIONS)).toBe(true);
    });

    it('returns false for a file with no extension', () => {
      expect(hasAllowedExtension('README', ALLOWED_MEMORY_EXTENSIONS)).toBe(false);
    });

    it('returns false for an empty string', () => {
      expect(hasAllowedExtension('', ALLOWED_MEMORY_EXTENSIONS)).toBe(false);
    });

    it('returns false for a dotfile (leading dot is not an extension per path.extname)', () => {
      // path.extname('.md') returns '' in Node.js, so '.md' does not match ['.md']
      expect(hasAllowedExtension('.md', ALLOWED_MEMORY_EXTENSIONS)).toBe(false);
    });

    it('returns false when the allowed list is empty', () => {
      expect(hasAllowedExtension('file.md', [])).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Allowed-extensions constants
  // -----------------------------------------------------------------------
  describe('allowed-extensions constants', () => {
    it('exports ALLOWED_MEMORY_EXTENSIONS containing .md', () => {
      expect(ALLOWED_MEMORY_EXTENSIONS).toEqual(['.md']);
    });

    it('exports ALLOWED_SESSION_EXTENSIONS containing .json', () => {
      expect(ALLOWED_SESSION_EXTENSIONS).toEqual(['.json']);
    });

    it('exports ALLOWED_LOCK_EXTENSIONS containing .lock', () => {
      expect(ALLOWED_LOCK_EXTENSIONS).toEqual(['.lock']);
    });
  });

  // -----------------------------------------------------------------------
  // ensureMemoryDir
  // -----------------------------------------------------------------------
  describe('ensureMemoryDir', () => {
    it('creates the project memory directory with recursive flag', async () => {
      await ensureMemoryDir('abc123');

      expect(mockMkdir).toHaveBeenCalledTimes(1);
      expect(mockMkdir).toHaveBeenCalledWith(
        path.join(MEMORY_BASE, 'abc123'),
        { recursive: true },
      );
    });

    it('uses a sanitised hash for the directory path', async () => {
      await ensureMemoryDir('abc/123');

      expect(mockMkdir).toHaveBeenCalledWith(
        path.join(MEMORY_BASE, 'abc_123'),
        { recursive: true },
      );
    });
  });

  // -----------------------------------------------------------------------
  // ensureSessionDirs
  // -----------------------------------------------------------------------
  describe('ensureSessionDirs', () => {
    it('creates session base and .archive directories recursively', async () => {
      await ensureSessionDirs();

      expect(mockMkdir).toHaveBeenCalledTimes(2);
      expect(mockMkdir).toHaveBeenCalledWith(SESSION_BASE, { recursive: true });
      expect(mockMkdir).toHaveBeenCalledWith(ARCHIVE_BASE, { recursive: true });
    });
  });

  // -----------------------------------------------------------------------
  // ensureGitignore
  // -----------------------------------------------------------------------
  describe('ensureGitignore', () => {
    const EXPECTED_CONTENT = `# kc-cli memory and session data
# Contains conversation transcripts and extracted memories
memory/
sessions/
*.json
*.md
!.gitignore
`;

    it('writes .gitignore when the file does not exist', async () => {
      mockAccess.mockRejectedValue(new Error('ENOENT'));

      await ensureGitignore(MEMORY_BASE);

      expect(mockAccess).toHaveBeenCalledWith(path.join(MEMORY_BASE, '.gitignore'));
      expect(mockWriteFile).toHaveBeenCalledTimes(1);
      expect(mockWriteFile).toHaveBeenCalledWith(
        path.join(MEMORY_BASE, '.gitignore'),
        EXPECTED_CONTENT,
        'utf-8',
      );
    });

    it('skips writing when .gitignore already exists', async () => {
      mockAccess.mockResolvedValue(undefined);

      await ensureGitignore(MEMORY_BASE);

      expect(mockAccess).toHaveBeenCalledWith(path.join(MEMORY_BASE, '.gitignore'));
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it('works with an arbitrary base path', async () => {
      mockAccess.mockRejectedValue(new Error('ENOENT'));
      const customPath = '/some/other/path';

      await ensureGitignore(customPath);

      expect(mockAccess).toHaveBeenCalledWith(path.join(customPath, '.gitignore'));
      expect(mockWriteFile).toHaveBeenCalledWith(
        path.join(customPath, '.gitignore'),
        EXPECTED_CONTENT,
        'utf-8',
      );
    });
  });
});
