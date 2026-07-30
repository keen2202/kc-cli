// Workspace-scope path checks (problem 1 fix): tools must reach files that sit
// at the same level as the workspace (sibling projects), while still refusing
// traversal far outside the project area. The access root is the workspace's
// parent directory; at a filesystem root it collapses to the root itself.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { assertPathWithinWorkspace, getWorkspaceAccessRoot } from '../../src/utils/path';

describe('getWorkspaceAccessRoot', () => {
  it('returns the parent of the workspace so siblings are in scope', () => {
    const cwd = path.resolve('/home/user/project');
    expect(getWorkspaceAccessRoot(cwd)).toBe(path.dirname(cwd));
  });

  it('collapses to the filesystem root (path.dirname fixed point)', () => {
    const root = path.parse(process.cwd()).root;
    expect(getWorkspaceAccessRoot(root)).toBe(root);
  });
});

describe('assertPathWithinWorkspace — workspace and its siblings', () => {
  let parent: string;
  let workspace: string;
  let sibling: string;

  beforeAll(() => {
    // realpath the temp dir up front: on some platforms os.tmpdir() is itself a
    // symlink, which would otherwise trip the symlink-escape check.
    parent = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kc-scope-')));
    workspace = path.join(parent, 'workspace');
    sibling = path.join(parent, 'sibling');
    fs.mkdirSync(workspace);
    fs.mkdirSync(sibling);
    fs.writeFileSync(path.join(workspace, 'w.txt'), 'hi');
    fs.writeFileSync(path.join(sibling, 'a.txt'), 'hi');
  });

  afterAll(() => {
    fs.rmSync(parent, { recursive: true, force: true });
  });

  it('allows a file inside the workspace', () => {
    expect(() => assertPathWithinWorkspace('w.txt', workspace)).not.toThrow();
  });

  it('allows a file in a sibling directory (same level as the workspace)', () => {
    expect(() => assertPathWithinWorkspace('../sibling/a.txt', workspace)).not.toThrow();
  });

  it('allows a not-yet-existing file in a sibling directory', () => {
    expect(() => assertPathWithinWorkspace('../sibling/new-file.txt', workspace)).not.toThrow();
  });

  it('allows an absolute path to a sibling directory', () => {
    expect(() => assertPathWithinWorkspace(path.join(sibling, 'a.txt'), workspace)).not.toThrow();
  });

  it('denies traversal above the parent scope', () => {
    expect(() => assertPathWithinWorkspace('../../escape.txt', workspace)).toThrow(
      /outside the workspace scope/,
    );
  });
});
