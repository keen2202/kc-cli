import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

// Mock fs module
vi.mock('fs', () => {
  const existsSync = vi.fn();
  const readdir = vi.fn();
  const readFile = vi.fn();
  return {
    default: { existsSync, promises: { readdir, readFile } },
    existsSync,
    promises: { readdir, readFile },
  };
});

// Mock os.homedir
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof os>();
  return { ...actual, homedir: vi.fn().mockReturnValue('/home/testuser') };
});

import { discoverPlugins, loadPlugin } from '../../src/plugins/plugin-loader';
import fs from 'fs';

const existsSync = vi.mocked(fs.existsSync);
const readdir = vi.mocked(fs.promises.readdir);
const readFile = vi.mocked(fs.promises.readFile);
const homedir = vi.mocked(os.homedir);

beforeEach(() => {
  vi.clearAllMocks();
  homedir.mockReturnValue('/home/testuser');
});

describe('discoverPlugins', () => {
  it('discovers user global plugins in ~/.kc-cli/plugins/', async () => {
    const userPluginDir = '/home/testuser/.kc-cli/plugins';
    existsSync.mockImplementation((p: any) => p === userPluginDir);
    readdir.mockResolvedValue([
      { name: 'my-plugin', isDirectory: () => true },
      { name: 'a-file.txt', isDirectory: () => false },
    ] as any);

    const result = await discoverPlugins('/project');
    expect(result).toContain(path.join(userPluginDir, 'my-plugin'));
    expect(result).not.toContain(path.join(userPluginDir, 'a-file.txt'));
  });

  it('discovers project plugins in .kc-cli/plugins/', async () => {
    const projectPluginDir = '/project/.kc-cli/plugins';
    existsSync.mockImplementation((p: any) => p === projectPluginDir);
    readdir.mockResolvedValue([
      { name: 'proj-plugin', isDirectory: () => true },
    ] as any);

    const result = await discoverPlugins('/project');
    expect(result).toContain(path.join(projectPluginDir, 'proj-plugin'));
  });

  it('discovers npm plugins matching kc-plugin-* prefix', async () => {
    const nodeModulesDir = '/project/node_modules';
    existsSync.mockImplementation((p: any) => p === nodeModulesDir);
    readdir.mockImplementation(async (p: any) => {
      if (p === nodeModulesDir) {
        return [
          { name: 'kc-plugin-foo', isDirectory: () => true },
          { name: 'kc-plugin-bar', isDirectory: () => true },
          { name: 'other-package', isDirectory: () => true },
        ];
      }
      return [];
    });

    const result = await discoverPlugins('/project');
    expect(result).toContain(path.join(nodeModulesDir, 'kc-plugin-foo'));
    expect(result).toContain(path.join(nodeModulesDir, 'kc-plugin-bar'));
    expect(result).not.toContain(path.join(nodeModulesDir, 'other-package'));
  });

  it('discovers scoped npm plugins under @scope/kc-plugin-*', async () => {
    const nodeModulesDir = '/project/node_modules';
    const scopeDir = path.join(nodeModulesDir, '@myscope');
    existsSync.mockImplementation((p: any) => p === nodeModulesDir);
    readdir.mockImplementation(async (p: any) => {
      if (p === nodeModulesDir) {
        return [{ name: '@myscope', isDirectory: () => true }];
      }
      if (p === scopeDir) {
        return [
          { name: 'kc-plugin-scoped', isDirectory: () => true },
          { name: 'other-scoped', isDirectory: () => false },
        ];
      }
      return [];
    });

    const result = await discoverPlugins('/project');
    expect(result).toContain(path.join(scopeDir, 'kc-plugin-scoped'));
  });

  it('discovers plugins from package.json dependencies', async () => {
    existsSync.mockImplementation((p: any) => {
      if (p === '/project/package.json') return true;
      if (p === '/project/node_modules/kc-plugin-dep') return true;
      return false;
    });
    readFile.mockResolvedValue(JSON.stringify({
      dependencies: {
        'kc-plugin-dep': '^1.0.0',
        'other-dep': '^2.0.0',
      },
    }));
    readdir.mockResolvedValue([]);

    const result = await discoverPlugins('/project');
    expect(result).toContain('/project/node_modules/kc-plugin-dep');
    expect(result).not.toContain(path.join('/project/node_modules', 'other-dep'));
  });

  it('reads devDependencies for kc-plugin-* entries too', async () => {
    existsSync.mockImplementation((p: any) => {
      if (p === '/project/package.json') return true;
      if (p === '/project/node_modules/kc-plugin-dev') return true;
      return false;
    });
    readFile.mockResolvedValue(JSON.stringify({
      devDependencies: {
        'kc-plugin-dev': '^1.0.0',
      },
    }));
    readdir.mockResolvedValue([]);

    const result = await discoverPlugins('/project');
    expect(result).toContain('/project/node_modules/kc-plugin-dev');
  });

  it('deduplicates plugin directories', async () => {
    const pluginPath = '/home/testuser/.kc-cli/plugins/kc-plugin-dupe';
    existsSync.mockImplementation((p: any) => p === pluginPath || p === '/home/testuser/.kc-cli/plugins');
    readdir.mockImplementation(async (p: any) => {
      if (p === '/home/testuser/.kc-cli/plugins') {
        return [{ name: 'kc-plugin-dupe', isDirectory: () => true }];
      }
      return [];
    });

    const result = await discoverPlugins('/project');
    const occurrences = result.filter(r => r === pluginPath);
    expect(occurrences).toHaveLength(1);
  });

  it('returns empty when no plugins found', async () => {
    existsSync.mockReturnValue(false);
    readdir.mockResolvedValue([]);

    const result = await discoverPlugins('/project');
    expect(result).toEqual([]);
  });

  it('handles errors reading node_modules gracefully', async () => {
    existsSync.mockImplementation((p: any) => p === '/project/node_modules');
    readdir.mockRejectedValue(new Error('permission denied'));

    const result = await discoverPlugins('/project');
    expect(result).toEqual([]);
  });

  it('handles errors reading scoped package directory', async () => {
    const nodeModulesDir = '/project/node_modules';
    const scopeDir = path.join(nodeModulesDir, '@badscope');
    existsSync.mockImplementation((p: any) => p === nodeModulesDir);
    readdir.mockImplementation(async (p: any) => {
      if (p === nodeModulesDir) {
        return [{ name: '@badscope', isDirectory: () => true }];
      }
      throw new Error('cannot read');
    });

    const result = await discoverPlugins('/project');
    expect(result).toEqual([]);
  });

  it('handles invalid package.json gracefully', async () => {
    existsSync.mockImplementation((p: any) => p === '/project/package.json');
    readFile.mockResolvedValue('not-json');
    readdir.mockResolvedValue([]);

    const result = await discoverPlugins('/project');
    expect(result).toEqual([]);
  });

  it('skips package.json deps that are not installed', async () => {
    existsSync.mockImplementation((p: any) => {
      if (p === '/project/package.json') return true;
      return false;
    });
    readFile.mockResolvedValue(JSON.stringify({
      dependencies: { 'kc-plugin-dep': '^1.0.0' },
    }));
    readdir.mockResolvedValue([]);

    const result = await discoverPlugins('/project');
    expect(result).toEqual([]);
  });

  it('skips non-directory entries in node_modules for scoped packages', async () => {
    const nodeModulesDir = '/project/node_modules';
    existsSync.mockImplementation((p: any) => p === nodeModulesDir);
    readdir.mockResolvedValue([
      { name: '@scope', isDirectory: () => false },
    ] as any);

    const result = await discoverPlugins('/project');
    expect(result).toEqual([]);
  });
});

// For loadPlugin tests, we need REAL files because the dynamic import() cannot be mocked
// by vi.mock. We create temp plugin directories.
describe('loadPlugin', () => {
  const tmpDir = path.join(os.tmpdir(), 'kc-cli-test-plugins');

  beforeAll(() => {
    execSync(`mkdir -p ${tmpDir}`);
  });

  afterAll(async () => {
    // Cleanup with a small delay to allow v8 coverage to finish reading files
    await new Promise(r => setTimeout(r, 100));
    try { execSync(`rm -rf ${tmpDir}`); } catch { /* ignore */ }
  });

  // Helper to create a real plugin directory using shell commands (bypasses fs mock)
  function createPluginDir(name: string, manifest: object, moduleContent: string, ext = '.mjs'): string {
    const dir = path.join(tmpDir, name);
    execSync(`mkdir -p ${dir}`);
    execSync(`cat > ${path.join(dir, 'package.json')} << 'PLUGINEOF'\n${JSON.stringify(manifest)}\nPLUGINEOF`);
    execSync(`cat > ${path.join(dir, 'index' + ext)} << 'PLUGINEOF'\n${moduleContent}\nPLUGINEOF`);
    return dir;
  }

  // For loadPlugin, we need to NOT mock fs since the function uses real fs.
  // But loadPlugin is imported from the module where fs is mocked.
  // We need a separate test approach: use unmocked fs calls directly.
  // Actually, the easiest approach: for each loadPlugin test, we configure the
  // fs mock to delegate to the real fs for our tmpDir paths.

  // Use vi.importActual to get the real fs module for the tmp directory tests
  let realExistsSync: typeof existsSync;
  let realReadFile: typeof readFile;

  beforeAll(async () => {
    // Enable dev mode to skip integrity hash requirement in tests
    process.env.KC_DEV_MODE = 'true';
    const realFs = await vi.importActual<typeof import('fs')>('fs');
    realExistsSync = vi.fn((p: any) => realFs.existsSync(p)) as any;
    realReadFile = vi.fn(async (p: any, encoding?: any) => realFs.promises.readFile(p, encoding)) as any;
  });

  function mockFsForTmpDir() {
    existsSync.mockImplementation((p: any) => realExistsSync(p as any));
    readFile.mockImplementation(async (p: any, encoding?: any) => realReadFile(p, encoding));
  }

  it('loads a valid plugin with kcPlugin flag', async () => {
    const dir = createPluginDir('valid-kc', {
      name: 'my-plugin',
      version: '1.0.0',
      main: 'index.mjs',
      kcPlugin: true,
    }, 'export default { name: "my-plugin", version: "1.0.0" };');

    mockFsForTmpDir();
    const plugin = await loadPlugin(dir);
    expect(plugin).not.toBeNull();
    expect(plugin!.name).toBe('my-plugin');
    expect(plugin!.version).toBe('1.0.0');
  });

  it('loads a plugin with kc-plugin-* name prefix', async () => {
    const dir = createPluginDir('valid-prefix', {
      name: 'kc-plugin-auto-discovered',
      version: '2.0.0',
      main: 'index.mjs',
    }, 'export default { name: "kc-plugin-auto-discovered", version: "2.0.0" };');

    mockFsForTmpDir();
    const plugin = await loadPlugin(dir);
    expect(plugin).not.toBeNull();
    expect(plugin!.name).toBe('kc-plugin-auto-discovered');
  });

  it('returns null when manifest (package.json) is missing', async () => {
    existsSync.mockReturnValue(false);
    const plugin = await loadPlugin('/nonexistent/path');
    expect(plugin).toBeNull();
  });

  it('returns null when manifest has no kcPlugin flag and wrong name', async () => {
    const dir = createPluginDir('no-flag', {
      name: 'not-a-plugin',
      version: '1.0.0',
      main: 'index.mjs',
    }, 'export default { name: "not-a-plugin", version: "1.0.0" };');

    mockFsForTmpDir();
    const plugin = await loadPlugin(dir);
    expect(plugin).toBeNull();
  });

  it('returns null when main entry file is missing', async () => {
    const dir = createPluginDir('no-main', {
      name: 'kc-plugin-broken',
      version: '1.0.0',
      main: 'index.mjs',
    }, '');
    // Delete the main file
    execSync(`rm -f ${path.join(dir, 'index.mjs')}`);

    mockFsForTmpDir();
    const plugin = await loadPlugin(dir);
    expect(plugin).toBeNull();
  });

  it('returns null when module has no name or version', async () => {
    const dir = createPluginDir('no-name', {
      name: 'kc-plugin-invalid',
      version: '1.0.0',
      main: 'index.mjs',
    }, 'export default { name: "", version: "" };');

    mockFsForTmpDir();
    const plugin = await loadPlugin(dir);
    expect(plugin).toBeNull();
  });

  it('returns null on import error (invalid JS)', async () => {
    const dir = createPluginDir('bad-js', {
      name: 'kc-plugin-crash',
      version: '1.0.0',
      main: 'index.mjs',
    }, 'this is not valid javascript @@@ !!!');

    mockFsForTmpDir();
    const plugin = await loadPlugin(dir);
    expect(plugin).toBeNull();
  });

  it('returns null on invalid JSON in manifest', async () => {
    const dir = createPluginDir('bad-json', {
      name: 'kc-plugin-json',
      version: '1.0.0',
      main: 'index.mjs',
    }, 'export default {};');
    // Overwrite package.json with invalid JSON
    execSync(`echo 'not valid json {{{' > ${path.join(dir, 'package.json')}`);

    mockFsForTmpDir();
    const plugin = await loadPlugin(dir);
    expect(plugin).toBeNull();
  });

  it('uses module namespace when no default or plugin export', async () => {
    const dir = createPluginDir('direct-export', {
      name: 'kc-plugin-direct',
      version: '3.0.0',
      main: 'index.mjs',
    }, 'export const name = "kc-plugin-direct"; export const version = "3.0.0";');

    mockFsForTmpDir();
    const plugin = await loadPlugin(dir);
    expect(plugin).not.toBeNull();
    expect(plugin!.name).toBe('kc-plugin-direct');
    expect(plugin!.version).toBe('3.0.0');
  });

  it('prefers .default export over .plugin export', async () => {
    const dir = createPluginDir('both-exports', {
      name: 'kc-plugin-both',
      version: '1.0.0',
      main: 'index.mjs',
    }, [
      'export default { name: "kc-plugin-both", version: "1.0.0", source: "default" };',
      'export const plugin = { name: "kc-plugin-both", version: "1.0.0", source: "plugin" };',
    ].join('\n'));

    mockFsForTmpDir();
    const plugin = await loadPlugin(dir);
    expect(plugin).not.toBeNull();
    expect((plugin as any).source).toBe('default');
  });

  it('falls back to .plugin export when no .default', async () => {
    const dir = createPluginDir('plugin-export', {
      name: 'kc-plugin-fallback',
      version: '1.0.0',
      main: 'index.mjs',
    }, 'export const plugin = { name: "kc-plugin-fallback", version: "1.0.0", source: "plugin" };');

    mockFsForTmpDir();
    const plugin = await loadPlugin(dir);
    expect(plugin).not.toBeNull();
    expect((plugin as any).source).toBe('plugin');
  });

  it('uses "index.js" as default main when not specified in manifest', async () => {
    // Create with .js extension (the default when main is not specified)
    const dir = createPluginDir('no-main-field', {
      name: 'kc-plugin-default-main',
      version: '1.0.0',
      kcPlugin: true,
      // No "main" field - defaults to index.js
    } as any, 'export default { name: "kc-plugin-default-main", version: "1.0.0" };', '.js');

    mockFsForTmpDir();
    const plugin = await loadPlugin(dir);
    expect(plugin).not.toBeNull();
    expect(plugin!.name).toBe('kc-plugin-default-main');
  });
});
