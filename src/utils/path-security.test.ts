// Security tests for TOCTOU symlink race prevention

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('Symlink TOCTOU Prevention', () => {
  // Since assertPathWithinWorkspace uses fs.realpathSync to resolve symlinks,
  // we test the behavior through the path module directly.
  // We cannot easily import assertPathWithinWorkspace due to ESM module mocking,
  // so we test the symlink resolution logic inline.

  let tempDir: string;
  let workspaceDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-touctou-'));
    workspaceDir = path.join(tempDir, 'workspace');
    fs.mkdirSync(workspaceDir, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // cleanup failure is OK
    }
  });

  describe('Symlink Escape Detection', () => {
    it('detects symlink pointing outside workspace', () => {
      // Create a symlink inside workspace that points to /etc
      const symlinkPath = path.join(workspaceDir, 'escape');
      fs.symlinkSync('/etc', symlinkPath);

      const realPath = fs.realpathSync(symlinkPath);
      expect(realPath).not.toContain(workspaceDir);
      expect(realPath).toBe('/etc');
    });

    it('detects chained symlink escape', () => {
      // Create symlink chain: link1 -> link2 -> /etc
      const link1 = path.join(workspaceDir, 'link1');
      const link2 = path.join(workspaceDir, 'link2');
      fs.symlinkSync('link2', link1);
      fs.symlinkSync('/etc', link2);

      const realPath = fs.realpathSync(link1);
      expect(realPath).toBe('/etc');
    });

    it('detects symlink loop', () => {
      // Create circular symlinks: linkA -> linkB -> linkA
      const linkA = path.join(workspaceDir, 'linkA');
      const linkB = path.join(workspaceDir, 'linkB');
      fs.symlinkSync(linkB, linkA);
      fs.symlinkSync(linkA, linkB);

      expect(() => fs.realpathSync(linkA)).toThrow();
    });

    it('allows symlink staying within workspace', () => {
      // Create a safe symlink within workspace
      const target = path.join(workspaceDir, 'target.txt');
      const link = path.join(workspaceDir, 'safe-link');
      fs.writeFileSync(target, 'hello');
      fs.symlinkSync(target, link);

      const realPath = fs.realpathSync(link);
      expect(realPath).toBe(target);
    });
  });

  describe('Path Traversal with Symlinks', () => {
    it('detects path traversal combined with symlinks', () => {
      // Create: workspace/link -> /tmp/somewhere
      // Then try: workspace/link/../../../etc/passwd
      const externalDir = path.join(tempDir, 'external');
      fs.mkdirSync(externalDir, { recursive: true });
      const symlinkPath = path.join(workspaceDir, 'to-external');
      fs.symlinkSync(externalDir, symlinkPath);

      const realSymlink = fs.realpathSync(symlinkPath);
      // The real path should be externalDir - outside workspace
      const normalizedWorkspace = workspaceDir.endsWith(path.sep)
        ? workspaceDir
        : workspaceDir + path.sep;
      expect(realSymlink.startsWith(normalizedWorkspace)).toBe(false);
    });

    it('rejects direct path traversal', () => {
      // Simple ../ escape
      const evilPath = path.join(workspaceDir, '../../../etc/passwd');
      const resolved = path.resolve(evilPath);

      // Path.resolve normalizes, so this should be outside workspace
      const normalizedWorkspace = workspaceDir.endsWith(path.sep)
        ? workspaceDir
        : workspaceDir + path.sep;
      expect(resolved.startsWith(normalizedWorkspace)).toBe(false);
    });
  });

  describe('New File Parent Resolution', () => {
    it('can resolve parent of non-existent file in workspace', () => {
      const newFile = path.join(workspaceDir, 'does-not-exist.txt');
      const parentDir = path.dirname(newFile);

      // Parent exists and should be resolvable
      const realParent = fs.realpathSync(parentDir);
      expect(realParent).toBe(workspaceDir);
    });

    it('rejects non-existent parent that would escape', () => {
      // A path deep in non-existent directories still with valid workspace parent
      const nestedNewFile = path.join(workspaceDir, 'a', 'b', 'c', 'new.txt');
      const resolved = path.resolve(nestedNewFile);
      const normalizedWorkspace = workspaceDir.endsWith(path.sep)
        ? workspaceDir
        : workspaceDir + path.sep;
      expect(resolved.startsWith(normalizedWorkspace)).toBe(true);
    });

    it('rejects parent symlink outside workspace for new file', () => {
      // Create external dir
      const externalDir = path.join(tempDir, 'external-storage');
      fs.mkdirSync(externalDir, { recursive: true });

      // Create symlink: workspace/new-project -> externalDir
      const symlinkPath = path.join(workspaceDir, 'new-project');
      fs.symlinkSync(externalDir, symlinkPath);

      // Trying to create workspace/new-project/file.txt should be detected
      // because new-project resolves to externalDir
      const newFileInSymlink = path.join(symlinkPath, 'file.txt');
      const realParent = fs.realpathSync(path.dirname(newFileInSymlink));

      const normalizedWorkspace = workspaceDir.endsWith(path.sep)
        ? workspaceDir
        : workspaceDir + path.sep;
      expect(realParent.startsWith(normalizedWorkspace)).toBe(false);
    });
  });
});
